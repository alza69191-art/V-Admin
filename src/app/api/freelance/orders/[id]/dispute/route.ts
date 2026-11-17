import {NextRequest,NextResponse} from "next/server";
import {currentCustomer} from "@/lib/customer-auth";
import {initDb,pool} from "@/lib/db";
import {ensureEscrowlySchema} from "@/lib/escrowly";
export const dynamic="force-dynamic";
export async function POST(req:NextRequest,{params}:{params:Promise<{id:string}>}){
 const customer=await currentCustomer();if(!customer)return NextResponse.json({error:"login_required"},{status:401});
 try{
  await initDb();await ensureEscrowlySchema();const {id}=await params;const orderId=Number(id);
  if(!Number.isSafeInteger(orderId)||orderId<1)return NextResponse.json({error:"invalid_order"},{status:400});
  const reason=String((await req.json().catch(()=>({}))).reason||"").trim().slice(0,1500);
  if(reason.length<20)return NextResponse.json({error:"اكتب سبب النزاع بالتفصيل (20 حرفاً على الأقل)."},{status:400});
  const found=await pool.query("SELECT * FROM v_freelance_orders WHERE id=$1 AND buyer_id=$2 LIMIT 1",[orderId,customer.id]);const order=found.rows[0];
  if(!order)return NextResponse.json({error:"order_not_found"},{status:404});
  if(!["funded","in_progress","delivered"].includes(String(order.status)))return NextResponse.json({error:"لا يمكن فتح نزاع في حالة العقد الحالية."},{status:409});
  await pool.query("UPDATE v_freelance_orders SET status='disputed',disputed_at=NOW() WHERE id=$1",[orderId]);
  await pool.query("INSERT INTO v_freelance_order_events(order_id,actor,from_status,to_status,note) VALUES($1,'buyer',$2,'disputed',$3)",[orderId,String(order.status),reason]);
  return NextResponse.json({ok:true,status:"disputed",message:"تم تسجيل النزاع وإيقاف إجراءات التسليم داخل المنصة. يجب على الإدارة مراجعة النزاع في لوحة Escrowly قبل اتخاذ قرار مالي."},{headers:{"Cache-Control":"no-store"}});
 }catch{return NextResponse.json({error:"تعذر تسجيل النزاع."},{status:503});}
}
