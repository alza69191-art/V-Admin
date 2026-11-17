import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { initDb, pool, withTransaction } from "@/lib/db";
import { ensureEscrowlySchema } from "@/lib/escrowly";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!await isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    await initDb();
    await ensureEscrowlySchema();
    const result = await pool.query(
      "SELECT p.id,p.order_id,p.seller_id,p.order_ref,p.gross_amount,p.gross_currency,p.escrow_transaction_id,p.escrow_mode,p.status,p.paid_amount,p.paid_currency,p.payout_method,p.payout_reference,p.paid_at,p.created_at,s.name AS seller_name,s.email AS seller_email FROM v_freelancer_payouts p JOIN v_customers s ON s.id=p.seller_id ORDER BY p.created_at DESC LIMIT 200"
    );
    return NextResponse.json(result.rows, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "تعذر تحميل سجل مستحقات المستقلين." }, { status: 503 });
  }
}

export async function PATCH(req: NextRequest) {
  if (!await isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    await initDb();
    await ensureEscrowlySchema();
    const body = await req.json().catch(() => ({}));
    const id = Number(body.id);
    const paidAmount = Number(body.paidAmount);
    const paidCurrency = String(body.paidCurrency || "").trim().toUpperCase();
    const payoutMethod = String(body.payoutMethod || "").trim();
    const payoutReference = String(body.payoutReference || "").trim().slice(0, 180);
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isFinite(paidAmount) || paidAmount <= 0 ||
        !/^[A-Z0-9]{2,8}$/.test(paidCurrency) ||
        !["bank_transfer", "wallet_transfer", "cash", "other"].includes(payoutMethod) ||
        payoutReference.length < 5) {
      return NextResponse.json({ error: "أدخل مبلغ التحويل وعملته وطريقته ومرجع إثبات صحيحاً." }, { status: 400 });
    }

    const payout = await withTransaction(async (connection) => {
      const [rows] = await connection.execute<any[]>(
        "SELECT id,order_id,order_ref,escrow_mode,status FROM v_freelancer_payouts WHERE id=? FOR UPDATE",
        [id]
      );
      const row = rows[0];
      if (!row) throw new Error("PAYOUT_NOT_FOUND");
      if (String(row.escrow_mode) !== "live") throw new Error("TEST_PAYOUT_NOT_PAYABLE");
      if (String(row.status) !== "pending") throw new Error("PAYOUT_NOT_PENDING");
      await connection.execute(
        "UPDATE v_freelancer_payouts SET status='paid',paid_amount=?,paid_currency=?,payout_method=?,payout_reference=?,paid_at=NOW() WHERE id=?",
        [paidAmount, paidCurrency, payoutMethod, payoutReference, id]
      );
      await connection.execute(
        "INSERT INTO v_freelance_order_events(order_id,actor,from_status,to_status,note) VALUES(?,'admin_payout','pending','paid',?)",
        [Number(row.order_id), "تم توثيق التحويل الخارجي للمستقل. المرجع: " + payoutReference]
      );
      return { id, orderRef: String(row.order_ref), status: "paid" };
    });
    return NextResponse.json({ ok: true, payout });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const messages: Record<string, string> = {
      PAYOUT_NOT_FOUND: "سجل المستحقات غير موجود.",
      TEST_PAYOUT_NOT_PAYABLE: "هذه معاملة اختبارية؛ لا يجوز تسجيلها كتحويل مالي حقيقي.",
      PAYOUT_NOT_PENDING: "تمت معالجة هذا السجل مسبقاً أو لم يعد مستحقاً."
    };
    return NextResponse.json({ error: messages[code] || "تعذر توثيق التحويل." }, { status: code in messages ? 409 : 503 });
  }
}
