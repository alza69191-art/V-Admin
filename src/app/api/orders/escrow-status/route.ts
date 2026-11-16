import { NextRequest, NextResponse } from "next/server";
import { currentCustomer } from "@/lib/customer-auth";
import { initDb, pool } from "@/lib/db";
import { readVaultionSession } from "@/lib/vaultion";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const customer = await currentCustomer();
  if (!customer) return NextResponse.json({ error: "login_required" }, { status: 401 });
  try {
    await initDb();
    const orderNumber = req.nextUrl.searchParams.get("orderNumber") || "";
    const result = await pool.query<any>("SELECT o.id,o.order_number,o.total,o.currency,e.session_id,e.status AS escrow_status,e.network,e.tx_hash FROM v_orders o JOIN v_order_escrows e ON e.order_id=o.id WHERE o.order_number=$1 AND o.customer_id=$2 LIMIT 1", [orderNumber, customer.id]);
    const row = result.rows[0];
    if (!row) return NextResponse.json({ error: "escrow_not_found" }, { status: 404 });
    if (!row.session_id) return NextResponse.json({ status: row.escrow_status || "creating" });
    const remote = await readVaultionSession(String(row.session_id));
    if (Number(remote.priceMinor) !== Math.round(Number(row.total) * 100) || remote.priceCurrency !== "USD") return NextResponse.json({ error: "escrow_amount_mismatch" }, { status: 409 });
    const allowed = new Set(["unpaid","reverted","escrow_funded","escrow_disputed","escrow_pending","escrow_released","escrow_refunded","escrow_closed","escrow_late"]);
    if (!allowed.has(remote.status)) return NextResponse.json({ error: "unknown_escrow_status" }, { status: 502 });
    await pool.query("UPDATE v_order_escrows SET status=$1,network=$2,tx_hash=$3 WHERE order_id=$4", [remote.status, remote.network || null, remote.settlement?.txHash || null, Number(row.id)]);
    return NextResponse.json({ orderNumber, status: remote.status, network: remote.network || null, explorer: remote.explorer || null, txHash: remote.settlement?.txHash || null });
  } catch {
    return NextResponse.json({ error: "vaultion_status_unavailable" }, { status: 503 });
  }
}
