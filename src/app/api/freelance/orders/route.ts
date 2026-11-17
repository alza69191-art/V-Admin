import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { currentCustomer } from "@/lib/customer-auth";
import { initDb, pool, withTransaction } from "@/lib/db";
import { assertEscrowlyReady, createEscrowlyTransaction, ensureEscrowlySchema } from "@/lib/escrowly";
import { enforceRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
const STOREFRONT = "https://v-storefront.onrender.com";

export async function GET() {
  const customer = await currentCustomer();
  if (!customer) return NextResponse.json({ error: "login_required" }, { status: 401 });
  try {
    await initDb();
    await ensureEscrowlySchema();
    const result = await pool.query(
      "SELECT o.*,s.title AS service_title,p.title AS project_title,c.name AS buyer_name,v.name AS seller_name FROM v_freelance_orders o LEFT JOIN v_freelancer_services s ON s.id=o.service_id LEFT JOIN v_projects p ON p.id=o.project_id JOIN v_customers c ON c.id=o.buyer_id JOIN v_customers v ON v.id=o.seller_id WHERE o.buyer_id=$1 OR o.seller_id=$1 ORDER BY o.created_at DESC LIMIT 100",
      [customer.id]
    );
    return NextResponse.json(result.rows.map((row:any) => ({
      ...row,
      escrow_checkout_url: Number(row.buyer_id) === Number(customer.id) ? row.escrow_checkout_url : null
    })), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "تعذر تحميل عقود العمل." }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production" && req.headers.get("origin") !== STOREFRONT)
    return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  const customer = await currentCustomer();
  if (!customer) return NextResponse.json({ error: "login_required" }, { status: 401 });

  let orderId = 0;
  try {
    const { mode } = assertEscrowlyReady();
    if (!process.env.ESCROWLY_WEBHOOK_SECRET)
      return NextResponse.json({ error: "ESCROWLY_WEBHOOK_SECRET_NOT_CONFIGURED" }, { status: 503 });
    await initDb();
    await ensureEscrowlySchema();
    const rate = await enforceRateLimit(req, "freelance-escrow-create", 4, 900, String(customer.id));
    if (!rate.allowed) return NextResponse.json({ error: "تم تجاوز عدد محاولات إنشاء الضمان. حاول لاحقاً." }, { status: 429 });

    const account = await pool.query("SELECT id,name,email,account_type,email_verified_at FROM v_customers WHERE id=$1 LIMIT 1", [customer.id]);
    const buyer = account.rows[0];
    if (!buyer?.email_verified_at || !["buyer", "both", "company"].includes(String(buyer.account_type)))
      return NextResponse.json({ error: "يلزم حساب مشتري موثق لبدء عقد العمل." }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const serviceId = body.serviceId == null ? 0 : Number(body.serviceId);
    const projectId = body.projectId == null ? 0 : Number(body.projectId);
    const bidId = body.bidId == null ? 0 : Number(body.bidId);
    if ((serviceId > 0 && (projectId > 0 || bidId > 0)) || (serviceId <= 0 && (projectId <= 0 || bidId <= 0)))
      return NextResponse.json({ error: "اختر خدمة منشورة أو عرضاً محدداً على مشروعك." }, { status: 400 });

    const orderRef = "VF-" + randomUUID().replace(/-/g, "").slice(0, 24).toUpperCase();
    const contract = await withTransaction(async connection => {
      let sellerId = 0, amount = 0, currency = "USD", resolvedServiceId:number|null = null, resolvedProjectId:number|null = null, resolvedBidId:number|null = null;
      if (serviceId > 0) {
        const [rows] = await connection.execute<any[]>(
          "SELECT id,seller_id,title,price,currency,status FROM v_freelancer_services WHERE id=? FOR UPDATE", [serviceId]
        );
        const service = rows[0];
        if (!service || service.status !== "active") throw new Error("SERVICE_UNAVAILABLE");
        sellerId = Number(service.seller_id); amount = Number(service.price); currency = String(service.currency || "USD").toUpperCase();
        resolvedServiceId = serviceId;
      } else {
        const [projects] = await connection.execute<any[]>(
          "SELECT id,owner_id,status,currency FROM v_projects WHERE id=? FOR UPDATE", [projectId]
        );
        const project = projects[0];
        if (!project || Number(project.owner_id) !== Number(customer.id) || project.status !== "open")
          throw new Error("PROJECT_NOT_AVAILABLE");
        const [existingContracts] = await connection.execute<any[]>(
          "SELECT id FROM v_freelance_orders WHERE project_id=? AND status IN ('creating_payment','awaiting_payment','funded','in_progress','delivered','disputed','resolution_pending') LIMIT 1 FOR UPDATE", [projectId]
        );
        if (existingContracts.length) throw new Error("PROJECT_ALREADY_AWARDED_OR_CHECKOUT_PENDING");
        const [bids] = await connection.execute<any[]>(
          "SELECT id,freelancer_id,amount,currency,status FROM v_project_bids WHERE id=? AND project_id=? FOR UPDATE", [bidId, projectId]
        );
        const bid = bids[0];
        if (!bid || bid.status !== "pending") throw new Error("BID_NOT_AVAILABLE");
        sellerId = Number(bid.freelancer_id); amount = Number(bid.amount); currency = String(bid.currency || project.currency || "USD").toUpperCase();
        resolvedProjectId = projectId; resolvedBidId = bidId;
      }
      if (sellerId === Number(customer.id)) throw new Error("SELF_PURCHASE");
      if (currency !== "USD" || !Number.isFinite(amount) || amount <= 0) throw new Error("USD_ONLY");
      const [insert] = await connection.execute<any>(
        "INSERT INTO v_freelance_orders(order_ref,buyer_id,seller_id,service_id,project_id,bid_id,total,currency,status,escrow_provider,escrow_status,escrow_mode) VALUES(?,?,?,?,?,?,?,'USD','creating_payment','escrowly','creating',?)",
        [orderRef, customer.id, sellerId, resolvedServiceId, resolvedProjectId, resolvedBidId, amount, mode]
      );
      const id = Number(insert.insertId);
      if (resolvedBidId) {
        const [bidUpdate] = await connection.execute<any>("UPDATE v_project_bids SET status='awaiting_payment',updated_at=NOW() WHERE id=? AND status='pending'", [resolvedBidId]);
        if (!bidUpdate.affectedRows) throw new Error("BID_NOT_AVAILABLE");
      }
      await connection.execute(
        "INSERT INTO v_freelance_order_events(order_id,actor,from_status,to_status,note) VALUES(?,'buyer',NULL,'creating_payment','تم إنشاء عقد بانتظار إنشاء معاملة الضمان')", [id]
      );
      return { id, sellerId, amount, orderRef };
    });
    orderId = contract.id;

    const stableCurrency = String(process.env.ESCROWLY_CURRENCY || "USDT").toUpperCase();
    if (!["USDT", "USDC", "DAI"].includes(stableCurrency)) throw new Error("ESCROWLY_CURRENCY_INVALID");
    const usdRate = Number(process.env.ESCROWLY_USD_RATE || "1");
    const converted = contract.amount * usdRate;
    if (!Number.isFinite(usdRate) || usdRate <= 0 || !Number.isFinite(converted) || converted <= 0) throw new Error("ESCROWLY_AMOUNT_CONFIGURATION_INVALID");
    const amount = converted.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
    const inspectionDays = Math.min(30, Math.max(1, Number(process.env.ESCROWLY_INSPECTION_DAYS || "3")));
    const feePayer = process.env.ESCROWLY_FEE_PAYER || "buyer";
    if (!["buyer", "seller", "split"].includes(feePayer)) throw new Error("ESCROWLY_FEE_PAYER_INVALID");

    const transaction = await createEscrowlyTransaction({
      amount, currency: stableCurrency,
      description: "V-Commerce freelance contract " + contract.orderRef,
      buyer_email: String(buyer.email),
      inspection_period_days: inspectionDays,
      fee_payer: feePayer,
      redirect_url: STOREFRONT + "/dashboard?escrow=return&order=" + encodeURIComponent(contract.orderRef),
      cancel_url: STOREFRONT + "/dashboard?escrow=cancel&order=" + encodeURIComponent(contract.orderRef),
      webhook_url: process.env.ESCROWLY_WEBHOOK_URL || "https://v-admin-api.onrender.com/api/webhooks/escrowly",
      metadata: { order_id: String(contract.id), freelance_order_id: String(contract.id), order_ref: contract.orderRef, platform: "v-commerce", order_type: "freelance" }
    });

    await pool.query(
      "UPDATE v_freelance_orders SET escrow_transaction_id=$1,escrow_checkout_url=$2,escrow_status=$3,status='awaiting_payment' WHERE id=$4 AND status='creating_payment'",
      [transaction.id, transaction.checkout_url, String(transaction.status || "awaiting_payment"), contract.id]
    );
    await pool.query(
      "INSERT INTO v_freelance_order_events(order_id,actor,from_status,to_status,note) VALUES($1,'system','creating_payment','awaiting_payment','تم إنشاء رابط دفع الضمان لدى Escrowly')",
      [contract.id]
    );
    return NextResponse.json({ ok: true, orderId: contract.id, orderRef: contract.orderRef, checkoutUrl: transaction.checkout_url, transactionId: transaction.id, mode, status: transaction.status || "awaiting_payment" }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "FREELANCE_ESCROW_ERROR";
    if (orderId) {
      await pool.query("UPDATE v_freelance_orders SET status='payment_creation_uncertain' WHERE id=$1 AND status='creating_payment'", [orderId]).catch(()=>{});
      await pool.query("INSERT INTO v_freelance_order_events(order_id,actor,from_status,to_status,note) VALUES($1,'system','creating_payment','payment_creation_uncertain','تعذر تأكيد نتيجة إنشاء معاملة الدفع؛ يلزم فحص الإدارة قبل أي إعادة محاولة')", [orderId]).catch(()=>{});
    }
    const messages:Record<string,string> = {
      SERVICE_UNAVAILABLE:"الخدمة غير متاحة للشراء حالياً.",
      PROJECT_NOT_AVAILABLE:"المشروع غير متاح أو لا تملك صلاحية اختياره.",
      PROJECT_ALREADY_AWARDED_OR_CHECKOUT_PENDING:"يوجد عقد أو عملية دفع قيد التنفيذ لهذا المشروع بالفعل.",
      BID_NOT_AVAILABLE:"العرض غير متاح أو سبق اختياره.",
      SELF_PURCHASE:"لا يمكنك شراء خدمتك أو اختيار عرضك.",
      USD_ONLY:"الضمان متاح حالياً للعقود المسعّرة بالدولار فقط.",
      ESCROWLY_CURRENCY_INVALID:"عملة الضمان غير مضبوطة في إعدادات المنصة.",
      ESCROWLY_AMOUNT_CONFIGURATION_INVALID:"إعداد تحويل مبلغ الضمان غير صالح.",
      ESCROWLY_FEE_PAYER_INVALID:"إعداد رسوم الضمان غير صالح."
    };
    const status = ["SERVICE_UNAVAILABLE","PROJECT_NOT_AVAILABLE","PROJECT_ALREADY_AWARDED_OR_CHECKOUT_PENDING","BID_NOT_AVAILABLE","SELF_PURCHASE","USD_ONLY"].includes(code) ? 409 : 502;
    return NextResponse.json({ error: messages[code] || code, orderId: orderId || undefined, manualReviewRequired: !!orderId }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
