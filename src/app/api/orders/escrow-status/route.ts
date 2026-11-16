import { NextRequest, NextResponse } from "next/server";
import { currentCustomer } from "@/lib/customer-auth";
import { initDb, pool } from "@/lib/db";
import { assertEscrowlyReady, ensureEscrowlySchema, readEscrowlyTransaction, sameMoney, validEscrowlyStatus } from "@/lib/escrowly";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const customer = await currentCustomer();
  if (!customer) return NextResponse.json({ error: "login_required" }, { status: 401 });
  try {
    await initDb();
    await ensureEscrowlySchema();
    const orderNumber = req.nextUrl.searchParams.get("orderNumber") || "";
    const result = await pool.query<any>(
      "SELECT o.id,o.order_number,o.total,o.currency,e.transaction_id,e.amount,e.currency AS escrow_currency,e.status AS escrow_status,e.mode,e.network,e.tx_hash FROM v_orders o JOIN v_order_escrows e ON e.order_id=o.id WHERE o.order_number=$1 AND o.customer_id=$2 LIMIT 1",
      [orderNumber, customer.id]
    );
    const row = result.rows[0];
    if (!row) return NextResponse.json({ error: "escrow_not_found" }, { status: 404 });
    if (!row.transaction_id) {
      return NextResponse.json({ status: row.escrow_status || "creating", legacyRecord: true }, { headers: { "Cache-Control": "no-store" } });
    }

    const { mode } = assertEscrowlyReady();
    if (String(row.mode) !== mode) return NextResponse.json({ error: "escrow_mode_mismatch" }, { status: 409 });
    const remote: any = await readEscrowlyTransaction(String(row.transaction_id));
    if (String(remote?.id) !== String(row.transaction_id) || !validEscrowlyStatus(remote?.status) ||
        String(remote?.mode || mode) !== mode ||
        String(remote?.currency || "").toUpperCase() !== String(row.escrow_currency).toUpperCase() ||
        !sameMoney(remote?.amount, row.amount) ||
        String(remote?.metadata?.order_id || "") !== String(row.id)) {
      return NextResponse.json({ error: "escrow_amount_or_identity_mismatch" }, { status: 409 });
    }

    await pool.query(
      "UPDATE v_order_escrows SET status=$1,network=$2,tx_hash=$3 WHERE order_id=$4",
      [remote.status, remote.network || null, remote.blockchain_tx_hash || null, Number(row.id)]
    );
    if (remote.status === "funded") {
      await pool.query("UPDATE v_orders SET status='paid',updated_at=NOW() WHERE id=$1 AND status IN ('pending','awaiting_payment')", [Number(row.id)]);
    }
    return NextResponse.json({
      orderNumber,
      status: remote.status,
      currency: remote.currency,
      amount: remote.amount,
      network: remote.network || null,
      txHash: remote.blockchain_tx_hash || null,
      mode,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "escrowly_status_unavailable";
    return NextResponse.json({ error: code }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
