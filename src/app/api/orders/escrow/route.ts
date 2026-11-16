import { NextRequest, NextResponse } from "next/server";
import { currentCustomer } from "@/lib/customer-auth";
import { initDb, pool } from "@/lib/db";
import { assertEscrowlyReady, createEscrowlyTransaction, ensureEscrowlySchema } from "@/lib/escrowly";

export const dynamic = "force-dynamic";
const STOREFRONT = "https://v-storefront.onrender.com";
const WEBHOOK = "https://v-admin-api.onrender.com/api/webhooks/escrowly";

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production" && req.headers.get("origin") !== STOREFRONT) {
    return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  }
  const customer = await currentCustomer();
  if (!customer) return NextResponse.json({ error: "login_required" }, { status: 401 });

  try {
    const { mode } = assertEscrowlyReady();
    if (!process.env.ESCROWLY_WEBHOOK_SECRET) return NextResponse.json({ error: "ESCROWLY_WEBHOOK_SECRET_NOT_CONFIGURED" }, { status: 503 });
    await initDb();
    const rate=await enforceRateLimit(req,"escrowly-create",5,900,String(customer.id));
    if(!rate.allowed)return NextResponse.json({error:"تم تجاوز عدد المحاولات المسموح. حاول لاحقاً."},{status:429,headers:{"Retry-After":String(rate.retryAfter),"Cache-Control":"no-store"}});
    await ensureEscrowlySchema();

    const body = await req.json().catch(() => ({}));
    const orderNumber = String(body?.orderNumber || "");
    if (!/^VC-[A-Z0-9-]{8,40}$/.test(orderNumber)) {
      return NextResponse.json({ error: "invalid_order" }, { status: 400 });
    }

    const found = await pool.query<any>(
      "SELECT id,order_number,currency,total,status,customer_email FROM v_orders WHERE order_number=$1 AND customer_id=$2 LIMIT 1",
      [orderNumber, customer.id]
    );
    const order = found.rows[0];
    if (!order) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
    if (order.status === "cancelled") return NextResponse.json({ error: "order_cancelled" }, { status: 409 });
    if (String(order.currency).toUpperCase() !== "USD") {
      return NextResponse.json({ error: "escrowly_requires_usd_order" }, { status: 400 });
    }

    const stableCurrency = String(process.env.ESCROWLY_CURRENCY || "USDT").toUpperCase();
    if (!["USDT", "USDC", "DAI"].includes(stableCurrency)) {
      return NextResponse.json({ error: "escrowly_currency_invalid" }, { status: 503 });
    }
    const rate = Number(process.env.ESCROWLY_USD_RATE || "1");
    const amount = Number(order.total) * rate;
    if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: "escrowly_amount_configuration_invalid" }, { status: 503 });
    }
    const amountText = amount.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
    const priceMinor = Math.round(Number(order.total) * 100);

    const inserted = await pool.query(
      "INSERT IGNORE INTO v_order_escrows(order_id,order_ref,status,price_minor,currency,mode,amount) VALUES($1,$2,'creating',$3,$4,$5,$6)",
      [Number(order.id), "vcommerce_" + orderNumber.toLowerCase(), priceMinor, stableCurrency, mode, amountText]
    );
    const savedResult = await pool.query<any>(
      "SELECT order_ref,price_minor,transaction_id,checkout_url,status,currency,mode,session_id FROM v_order_escrows WHERE order_id=$1 LIMIT 1",
      [Number(order.id)]
    );
    const saved = savedResult.rows[0];
    if (!saved || Number(saved.price_minor) !== priceMinor || String(saved.currency || stableCurrency) !== stableCurrency) {
      return NextResponse.json({ error: "escrow_order_conflict" }, { status: 409 });
    }
    if (saved.transaction_id && saved.checkout_url) {
      return NextResponse.json({ ok: true, checkoutUrl: saved.checkout_url, transactionId: saved.transaction_id, status: saved.status, mode: saved.mode, reused: true });
    }
    if (!inserted.rowCount) {
      return NextResponse.json({ error: "escrow_creation_state_uncertain_contact_support" }, { status: 409 });
    }
    if (saved.session_id) {
      return NextResponse.json({ error: "legacy_escrow_record_requires_admin_review" }, { status: 409 });
    }

    const inspectionDays = Math.min(30, Math.max(1, Number(process.env.ESCROWLY_INSPECTION_DAYS || "3")));
    const feePayer = process.env.ESCROWLY_FEE_PAYER || "buyer";
    if (!["buyer", "seller", "split"].includes(feePayer)) {
      return NextResponse.json({ error: "escrowly_fee_payer_invalid" }, { status: 503 });
    }

    const transaction = await createEscrowlyTransaction({
      amount: amountText,
      currency: stableCurrency,
      description: "V-Commerce order " + orderNumber,
      buyer_email: String(order.customer_email),
      inspection_period_days: inspectionDays,
      fee_payer: feePayer,
      redirect_url: STOREFRONT + "/products?escrowly=return&order=" + encodeURIComponent(orderNumber),
      cancel_url: STOREFRONT + "/products?escrowly=cancel&order=" + encodeURIComponent(orderNumber),
      webhook_url: process.env.ESCROWLY_WEBHOOK_URL || WEBHOOK,
      metadata: { order_id: String(order.id), order_number: orderNumber, platform: "v-commerce" },
    });

    await pool.query(
      "UPDATE v_order_escrows SET transaction_id=$1,session_id=NULL,checkout_url=$2,status=$3,currency=$4,mode=$5,amount=$6 WHERE order_id=$7 AND transaction_id IS NULL",
      [transaction.id, transaction.checkout_url, String(transaction.status || "awaiting_payment"), stableCurrency, mode, amountText, Number(order.id)]
    );
    return NextResponse.json({
      ok: true,
      checkoutUrl: transaction.checkout_url,
      transactionId: transaction.id,
      status: transaction.status || "awaiting_payment",
      mode,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "ESCROWLY_ERROR";
    const status = code === "ESCROWLY_API_KEY_NOT_CONFIGURED" || code === "ESCROWLY_LIVE_MODE_DISABLED" ? 503 : 502;
    return NextResponse.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
