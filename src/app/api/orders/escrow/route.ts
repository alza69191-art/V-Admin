import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { currentCustomer } from "@/lib/customer-auth";
import { initDb, pool } from "@/lib/db";
import { createVaultionCheckout } from "@/lib/vaultion";

export const dynamic = "force-dynamic";
const STOREFRONT = "https://v-storefront.onrender.com";

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production" && req.headers.get("origin") !== STOREFRONT) return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  const customer = await currentCustomer();
  if (!customer) return NextResponse.json({ error: "login_required" }, { status: 401 });
  try {
    await initDb();
    const body = await req.json();
    const orderNumber = String(body?.orderNumber || "");
    if (!/^VC-[A-Z0-9-]{8,40}$/.test(orderNumber)) return NextResponse.json({ error: "invalid_order" }, { status: 400 });
    const found = await pool.query<any>("SELECT id,order_number,currency,total,status FROM v_orders WHERE order_number=$1 AND customer_id=$2 LIMIT 1", [orderNumber, customer.id]);
    const order = found.rows[0];
    if (!order) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
    if (String(order.currency).toUpperCase() !== "USD") return NextResponse.json({ error: "vaultion_usd_only" }, { status: 400 });
    const priceMinor = Math.round(Number(order.total) * 100);
    if (!Number.isSafeInteger(priceMinor) || priceMinor < 5000) return NextResponse.json({ error: "escrow_minimum_50_usd" }, { status: 400 });
    if (order.status === "cancelled") return NextResponse.json({ error: "order_cancelled" }, { status: 409 });
    const setting = await pool.query<any>("SELECT value FROM v_settings WHERE `key`=$1 LIMIT 1", ["vaultionTronWallet"]);
    const rawWallet = setting.rows[0]?.value;
    const wallet = typeof rawWallet === "string" ? JSON.parse(rawWallet) : rawWallet;
    if (typeof wallet !== "string" || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(wallet)) return NextResponse.json({ error: "vaultion_wallet_not_configured" }, { status: 503 });
    await pool.query("INSERT IGNORE INTO v_order_escrows(order_id,order_ref,status,price_minor) VALUES($1,$2,'creating',$3)", [Number(order.id), "vcommerce_" + orderNumber.toLowerCase() + "_" + randomBytes(8).toString("hex"), priceMinor]);
    const saved = await pool.query<any>("SELECT order_ref,price_minor,session_id,checkout_url,status FROM v_order_escrows WHERE order_id=$1 LIMIT 1", [Number(order.id)]);
    const escrow = saved.rows[0];
    if (!escrow || Number(escrow.price_minor) !== priceMinor) return NextResponse.json({ error: "escrow_order_conflict" }, { status: 409 });
    if (escrow.session_id && escrow.checkout_url) return NextResponse.json({ ok: true, checkoutUrl: escrow.checkout_url, sessionId: escrow.session_id, reused: true });
    const payload = {
      store: { url: STOREFRONT, name: "V-Commerce" },
      orderRef: escrow.order_ref,
      name: "V-Commerce order " + orderNumber,
      priceMinor,
      escrow: "required",
      receiving: { tron: wallet },
      networks: ["tron"],
      theme: "light",
      returnUrl: STOREFRONT + "/products?vaultion=return&order=" + encodeURIComponent(orderNumber),
    };
    const session = await createVaultionCheckout(payload);
    const checkoutUrl = "https://checkout.vaultion.org" + session.checkoutPath;
    await pool.query("UPDATE v_order_escrows SET session_id=$1,checkout_url=$2,status='unpaid' WHERE order_id=$3", [session.sessionId, checkoutUrl, Number(order.id)]);
    return NextResponse.json({ ok: true, checkoutUrl, sessionId: session.sessionId });
  } catch (error) {
    const code = error instanceof Error ? error.message : "vaultion_error";
    return NextResponse.json({ error: code }, { status: 502 });
  }
}
