import { NextRequest, NextResponse } from "next/server";
import { currentCustomer } from "@/lib/customer-auth";
import { initDb, pool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const customer = await currentCustomer();
  if (!customer) return NextResponse.json({ error: "يجب تسجيل الدخول أولاً." }, { status: 401 });
  try {
    await initDb();
    const [projects, services] = await Promise.all([
      pool.query(
        "SELECT id,title,description,category,budget_min,budget_max,currency,delivery_days,status,visibility,created_at FROM v_projects WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100",
        [customer.id]
      ),
      pool.query(
        "SELECT id,title,description,category,price,currency,delivery_days,revisions,status,created_at FROM v_freelancer_services WHERE seller_id=$1 ORDER BY created_at DESC LIMIT 100",
        [customer.id]
      )
    ]);
    return NextResponse.json({ projects: projects.rows, services: services.rows }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "تعذر تحميل منشورات حسابك." }, { status: 503 });
  }
}

export async function PATCH(req: NextRequest) {
  const customer = await currentCustomer();
  if (!customer) return NextResponse.json({ error: "يجب تسجيل الدخول أولاً." }, { status: 401 });
  try {
    await initDb();
    const body = await req.json().catch(() => ({}));
    const type = String(body.type || "");
    const id = Number(body.id);
    const status = String(body.status || "");
    if (!Number.isSafeInteger(id) || id < 1 || !["open", "paused", "active"].includes(status)) {
      return NextResponse.json({ error: "البيانات غير صالحة." }, { status: 400 });
    }

    if (type === "project") {
      if (!["open", "paused"].includes(status)) return NextResponse.json({ error: "حالة المشروع غير مسموحة." }, { status: 400 });
      const result = await pool.query(
        "SELECT id,status FROM v_projects WHERE id=$1 AND owner_id=$2 LIMIT 1",
        [id, customer.id]
      );
      if (!result.rows.length) return NextResponse.json({ error: "المشروع غير موجود في حسابك." }, { status: 404 });
      if (String(result.rows[0].status) === "cancelled") return NextResponse.json({ error: "لا يمكن إعادة فتح مشروع مغلق نهائياً." }, { status: 409 });
      await pool.query("UPDATE v_projects SET status=$1,visibility=$2 WHERE id=$3 AND owner_id=$4", [
        status, status === "open" ? "public" : "private", id, customer.id
      ]);
    } else if (type === "service") {
      if (!["active", "paused"].includes(status)) return NextResponse.json({ error: "حالة الخدمة غير مسموحة." }, { status: 400 });
      const result = await pool.query(
        "SELECT id,status FROM v_freelancer_services WHERE id=$1 AND seller_id=$2 LIMIT 1",
        [id, customer.id]
      );
      if (!result.rows.length) return NextResponse.json({ error: "الخدمة غير موجودة في حسابك." }, { status: 404 });
      if (!["active", "paused"].includes(String(result.rows[0].status))) return NextResponse.json({ error: "لا يمكن تعديل حالة خدمة قبل موافقة الإدارة أو بعد رفضها." }, { status: 409 });
      await pool.query("UPDATE v_freelancer_services SET status=$1 WHERE id=$2 AND seller_id=$3", [status, id, customer.id]);
    } else {
      return NextResponse.json({ error: "نوع المنشور غير صالح." }, { status: 400 });
    }
    return NextResponse.json({ ok: true, type, id, status });
  } catch {
    return NextResponse.json({ error: "تعذر تحديث المنشور." }, { status: 503 });
  }
}
