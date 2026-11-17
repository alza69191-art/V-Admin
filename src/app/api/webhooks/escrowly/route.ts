import { NextRequest, NextResponse } from "next/server";
import { initDb, pool, withTransaction } from "@/lib/db";
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
    if (!local) {
      const freelanceResult = await pool.query<any>(
        "SELECT id,order_ref,buyer_id,seller_id,total,currency,escrow_status,escrow_provider,escrow_mode,status,escrow_transaction_id,project_id,bid_id FROM v_freelance_orders WHERE escrow_transaction_id=$1 LIMIT 1",
        [transactionId]
      );
      const freelance = freelanceResult.rows[0];
      if (!freelance) return NextResponse.json({ error: "transaction_not_found" }, { status: 404 });
      if (String(freelance.escrow_provider) !== "escrowly" || String(freelance.escrow_mode) !== mode) return NextResponse.json({ error: "transaction_provider_or_mode_mismatch" }, { status: 409 });

      const remote: any = await readEscrowlyTransaction(transactionId);
      if (String(remote?.id) !== transactionId || !validEscrowlyStatus(remote?.status) ||
          String(remote?.mode || mode) !== mode ||
          String(remote?.currency || "").toUpperCase() !== String(process.env.ESCROWLY_CURRENCY || "USDT").toUpperCase() ||
          !sameMoney(remote?.amount, Number(freelance.total) * Number(process.env.ESCROWLY_USD_RATE || "1")) ||
          String(remote?.metadata?.freelance_order_id || "") !== String(freelance.id) ||
          String(remote?.metadata?.order_ref || "") !== String(freelance.order_ref)) {
        return NextResponse.json({ error: "freelance_transaction_reconciliation_failed" }, { status: 409 });
      }

      const nextStatus:Record<string,string> = {
        funded:"funded", completed:"completed", disputed:"disputed", refunded:"refunded",
        resolved:"resolution_pending", cancelled:"cancelled", expired:"cancelled"
      };
      const next = nextStatus[String(remote.status)] || String(freelance.status);
      const result = await withTransaction(async (connection) => {
        const [insertResult] = await connection.execute<any>(
          "INSERT IGNORE INTO v_escrowly_webhook_events(event_id,transaction_id,event_type,mode) VALUES(?,?,?,?)",
          [eventId, transactionId, eventType, mode]
        );
        if (!insertResult.affectedRows) return { duplicate: true };
        await connection.execute(
          "UPDATE v_freelance_orders SET escrow_status=?,status=CASE WHEN status IN ('disputed','refunded','completed','cancelled','payment_creation_uncertain') THEN status ELSE ? END WHERE id=?",
          [String(remote.status), next, Number(freelance.id)]
        );
        if (remote.status === "completed") {
          const payoutAmount = Number(remote.amount);
          const payoutCurrency = String(remote.currency || "").toUpperCase();
          if (!Number.isFinite(payoutAmount) || payoutAmount <= 0 || !/^[A-Z0-9]{2,8}$/.test(payoutCurrency)) {
            throw new Error("ESCROWLY_COMPLETED_PAYOUT_AMOUNT_INVALID");
          }
          await connection.execute(
            "INSERT IGNORE INTO v_freelancer_payouts(order_id,seller_id,order_ref,gross_amount,gross_currency,escrow_transaction_id,escrow_mode,status) VALUES(?,?,?,?,?,?,?,?)",
            [Number(freelance.id), Number(freelance.seller_id), String(freelance.order_ref), payoutAmount, payoutCurrency, transactionId, mode, mode === "test" ? "simulated" : "pending"]
          );
        }
        if (remote.status === "funded" && freelance.status === "awaiting_payment") {
          const [current] = await connection.execute<any[]>("SELECT project_id,bid_id FROM v_freelance_orders WHERE id=? FOR UPDATE",[Number(freelance.id)]);
          const contract = current[0];
          if (contract?.project_id && contract?.bid_id) {
            await connection.execute("UPDATE v_project_bids SET status='accepted',updated_at=NOW() WHERE id=? AND project_id=? AND status IN ('pending','awaiting_payment')",[contract.bid_id,contract.project_id]);
            await connection.execute("UPDATE v_project_bids SET status='rejected',updated_at=NOW() WHERE project_id=? AND id<>? AND status IN ('pending','awaiting_payment')",[contract.project_id,contract.bid_id]);
            await connection.execute("UPDATE v_projects SET status='in_progress',updated_at=NOW() WHERE id=? AND status='open'",[contract.project_id]);
          }
        }
        if ((remote.status === "cancelled" || remote.status === "expired") && freelance.project_id && freelance.bid_id) {
          await connection.execute("UPDATE v_project_bids SET status='pending',updated_at=NOW() WHERE id=? AND status='awaiting_payment'",[Number(freelance.bid_id)]);
        }
        await connection.execute(
          "INSERT INTO v_freelance_order_events(order_id,actor,from_status,to_status,note) VALUES(?,'escrowly',?,?,?)",
          [Number(freelance.id),String(freelance.status),next,"تمت مزامنة حالة الضمان من حدث Escrowly: "+String(remote.status)]
        );
        return { duplicate: false };
      });
      return NextResponse.json({ ok: true, duplicate: result.duplicate, type: "freelance" });
    }
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

    // Persist the event and all related order changes atomically. If any write fails,
    // the event insert rolls back so Escrowly's retry can safely process it again.
    const result = await withTransaction(async (connection) => {
      const [insertResult] = await connection.execute<any>(
        "INSERT IGNORE INTO v_escrowly_webhook_events(event_id,transaction_id,event_type,mode) VALUES(?,?,?,?)",
        [eventId, transactionId, eventType, mode]
      );
      if (!insertResult.affectedRows) return { duplicate: true };

      await connection.execute(
        "UPDATE v_order_escrows SET status=?,network=?,tx_hash=? WHERE transaction_id=?",
        [remote.status, remote.network || null, remote.blockchain_tx_hash || null, transactionId]
      );
      if (remote.status === "funded") {
        const [orderUpdate] = await connection.execute<any>(
          "UPDATE v_orders SET status='paid',updated_at=NOW() WHERE id=? AND status IN ('pending','awaiting_payment')",
          [Number(local.order_id)]
        );
        if (orderUpdate.affectedRows > 0) {
          await connection.execute(
            "INSERT INTO v_order_events(order_id,actor,from_status,to_status,note) VALUES(?,'escrowly',NULL,'paid','Escrowly confirmed funds secured in escrow')",
            [Number(local.order_id)]
          );
        }
      }
      return { duplicate: false };
    });
    return NextResponse.json({ ok: true, duplicate: result.duplicate });
  } catch (error) {
    const code = error instanceof Error ? error.message : "webhook_processing_failed";
    return NextResponse.json({ error: code }, { status: 500 });
  }
}
