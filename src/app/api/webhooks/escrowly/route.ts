import { NextRequest, NextResponse } from "next/server";
import { initDb, pool } from "@/lib/db";
import { assertEscrowlyReady, ensureEscrowlySchema, readEscrowlyTransaction, sameMoney, validEscrowlyStatus, verifyEscrowlySignature } from "@/lib/escrowly";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { mode } = assertEscrowlyReady();
    const secret = process.env.ESCROWLY_WEBHOOK_SECRET || "";
    if (!secret) return NextResponse.json({ error: "webhook_not_configured" }, { status: 503 });

    const rawBody = await req.text();
    if (rawBody.length > 128 * 1024) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    const signature = req.headers.get("x-escrowly-signature") || "";
    if (!verifyEscrowlySignature(rawBody, signature, secret)) {
      return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
    }

    const payload: any = JSON.parse(rawBody);
    const eventId = req.headers.get("x-escrowly-event-id") || "";
    const eventType = req.headers.get("x-escrowly-event") || "";
    if (!eventId || eventId !== payload?.id || !/^wh_evt_[a-zA-Z0-9-]{8,100}$/.test(eventId) ||
        !eventType || eventType !== payload?.event || payload?.mode !== mode) {
      return NextResponse.json({ error: "invalid_event_headers_or_mode" }, { status: 400 });
    }
    const transactionId = String(payload?.data?.transaction_id || "");
    if (!transactionId) return NextResponse.json({ error: "missing_transaction_id" }, { status: 400 });

    await initDb();
    await ensureEscrowlySchema();
    const localResult = await pool.query<any>(
      "SELECT e.order_id,e.amount,e.currency,e.mode,o.total,o.order_number FROM v_order_escrows e JOIN v_orders o ON o.id=e.order_id WHERE e.transaction_id=$1 LIMIT 1",
      [transactionId]
    );
    const local = localResult.rows[0];
    if (!local) return NextResponse.json({ error: "transaction_not_found" }, { status: 404 });
    if (String(local.mode) !== mode) return NextResponse.json({ error: "transaction_mode_mismatch" }, { status: 409 });

    // A signed webhook is authenticated, but we still reconcile against Escrowly's authenticated transaction read.
    const remote: any = await readEscrowlyTransaction(transactionId);
    if (String(remote?.id) !== transactionId || !validEscrowlyStatus(remote?.status) ||
        String(remote?.mode || mode) !== mode ||
        String(remote?.currency || "").toUpperCase() !== String(local.currency).toUpperCase() ||
        !sameMoney(remote?.amount, local.amount) ||
        String(remote?.metadata?.order_id || "") !== String(local.order_id)) {
      return NextResponse.json({ error: "transaction_reconciliation_failed" }, { status: 409 });
    }

    const inserted = await pool.query(
      "INSERT IGNORE INTO v_escrowly_webhook_events(event_id,transaction_id,event_type,mode) VALUES($1,$2,$3,$4)",
      [eventId, transactionId, eventType, mode]
    );
    if (!inserted.rowCount) return NextResponse.json({ ok: true, duplicate: true });

    await pool.query(
      "UPDATE v_order_escrows SET status=$1,network=$2,tx_hash=$3 WHERE transaction_id=$4",
      [remote.status, remote.network || null, remote.blockchain_tx_hash || null, transactionId]
    );
    if (remote.status === "funded") {
      await pool.query("UPDATE v_orders SET status='paid',updated_at=NOW() WHERE id=$1 AND status IN ('pending','awaiting_payment')", [Number(local.order_id)]);
      await pool.query(
        "INSERT INTO v_order_events(order_id,actor,from_status,to_status,note) VALUES($1,'escrowly',NULL,'paid','Escrowly confirmed funds secured in escrow')",
        [Number(local.order_id)]
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const code = error instanceof Error ? error.message : "webhook_processing_failed";
    return NextResponse.json({ error: code }, { status: 500 });
  }
}
