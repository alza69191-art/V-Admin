import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/auth";
import { initDb, pool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!await isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    await initDb();
    const [projects, services] = await Promise.all([
      pool.query(
        "SELECT p.id,p.owner_id,p.title,p.description,p.category,p.budget_min,p.budget_max,p.currency,p.delivery_days,p.status,p.visibility,p.created_at,c.name AS owner_name,c.email AS owner_email,(SELECT COUNT(*) FROM v_project_bids b WHERE b.project_id=p.id) AS bids_count FROM v_projects p JOIN v_customers c ON c.id=p.owner_id ORDER BY p.created_at DESC LIMIT 300"
      ),
      pool.query(
        "SELECT s.id,s.seller_id,s.title,s.description,s.category,s.price,s.currency,s.delivery_days,s.revisions,s.tags,s.status,s.created_at,c.name AS seller_name,c.email AS seller_email FROM v_freelancer_services s JOIN v_customers c ON c.id=s.seller_id ORDER BY s.created_at DESC LIMIT 300"
      )
    ]);
    return NextResponse.json({ projects: projects.rows, services: services.rows }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "تعذر تحميل عروض السوق." }, { status: 503 });
  }
}

export async function PATCH(req: NextRequest) {
  if (!await isAdmin()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    await initDb();
    const body = await req.json().catch(() => ({}));
    const type = String(body.type || "");
    const id = Number(body.id);
    const status = String(body.status || "");
    if (!Number.isSafeInteger(id) || id < 1) return NextResponse.json({ error: "معرّف العنصر غير صالح." }, { status: 400 });

    if (type === "project") {
      if (!["open", "paused", "cancelled"].includes(status)) return NextResponse.json({ error: "حالة المشروع غير صالحة." }, { status: 400 });
      const result = await pool.query("UPDATE v_projects SET status=$1,visibility=$2 WHERE id=$3", [status, status === "open" ? "public" : "private", id]);
      if (!result.rowCount) return NextResponse.json({ error: "المشروع غير موجود." }, { status: 404 });
    } else if (type === "service") {
      if (!["active", "pending", "paused", "rejected"].includes(status)) return NextResponse.json({ error: "حالة الخدمة غير صالحة." }, { status: 400 });
      const result = await pool.query("UPDATE v_freelancer_services SET status=$1 WHERE id=$2", [status, id]);
      if (!result.rowCount) return NextResponse.json({ error: "الخدمة غير موجودة." }, { status: 404 });
    } else {
      return NextResponse.json({ error: "نوع العنصر غير صالح." }, { status: 400 });
    }
    await pool.query("INSERT INTO v_audit(actor,action,entity,entity_id) VALUES('admin',$1,$2,$3)", [
      "marketplace_status:" + status, type, String(id)
    ]);
    return NextResponse.json({ ok: true, type, id, status });
  } catch {
    return NextResponse.json({ error: "تعذر تحديث حالة العنصر." }, { status: 503 });
  }
}
