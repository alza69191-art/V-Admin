import {NextRequest,NextResponse} from "next/server";
import {isAdmin} from "@/lib/auth";
import {initDb,pool} from "@/lib/db";
import {ensureEscrowlySchema} from "@/lib/escrowly";
export const dynamic="force-dynamic";
export async function GET(){
 if(!await isAdmin())return NextResponse.json({error:"unauthorized"},{status:401});
 try{
  await initDb();await ensureEscrowlySchema();
  const orders=await pool.query("SELECT o.id,o.order_ref,o.buyer_id,o.seller_id,o.service_id,o.project_id,o.bid_id,o.total,o.currency,o.status,o.escrow_provider,o.escrow_transaction_id,o.escrow_status,o.delivered_at,o.disputed_at,o.admin_note,o.admin_reviewed_at,o.created_at,b.name AS buyer_name,b.email AS buyer_email,s.name AS seller_name,s.email AS seller_email,fs.title AS service_title,p.title AS project_title FROM v_freelance_orders o JOIN v_customers b ON b.id=o.buyer_id JOIN v_customers s ON s.id=o.seller_id LEFT JOIN v_freelancer_services fs ON fs.id=o.service_id LEFT JOIN v_projects p ON p.id=o.project_id ORDER BY o.created_at DESC LIMIT 200");
  if(!orders.rows.length)return NextResponse.json([]);
  const ids=orders.rows.map((x:any)=>Number(x.id));
  const events=await pool.query("SELECT * FROM v_freelance_order_events WHERE order_id IN ("+ids.map((_,i)=>"$"+(i+1)).join(",")+") ORDER BY created_at ASC",ids);
  const grouped=new Map<number,any[]>();for(const e of events.rows){const id=Number(e.order_id);if(!grouped.has(id))grouped.set(id,[]);grouped.get(id)!.push(e);}
  return NextResponse.json(orders.rows.map((o:any)=>({...o,events:grouped.get(Number(o.id))||[]})),{headers:{"Cache-Control":"no-store"}});
 }catch{return NextResponse.json({error:"تعذر تحميل عقود المستقلين."},{status:503});}
}
export async function PATCH(req:NextRequest){
 if(!await isAdmin())return NextResponse.json({error:"unauthorized"},{status:401});
 try{
  await initDb();await ensureEscrowlySchema();const body=await req.json().catch(()=>({}));const id=Number(body.id),note=String(body.note||"").trim().slice(0,4000);
  if(!Number.isSafeInteger(id)||id<1||note.length<5)return NextResponse.json({error:"أدخل رقم عقد وملاحظة إدارية صحيحة."},{status:400});
  const found=await pool.query("SELECT status FROM v_freelance_orders WHERE id=$1 LIMIT 1",[id]);const order=found.rows[0];if(!order)return NextResponse.json({error:"العقد غير موجود."},{status:404});
  await pool.query("UPDATE v_freelance_orders SET admin_note=$1,admin_reviewed_at=NOW() WHERE id=$2",[note,id]);
  await pool.query("INSERT INTO v_freelance_order_events(order_id,actor,from_status,to_status,note) VALUES($1,'admin',$2,$2,$3)",[id,String(order.status),note]);
  return NextResponse.json({ok:true});
 }catch{return NextResponse.json({error:"تعذر حفظ الملاحظة الإدارية."},{status:503});}
}
