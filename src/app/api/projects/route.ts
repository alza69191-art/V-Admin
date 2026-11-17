import {NextRequest,NextResponse} from "next/server";
import {pool,initDb} from "@/lib/db";
import {currentCustomer} from "@/lib/customer-auth";
export const dynamic="force-dynamic";
export async function GET(req:NextRequest){
 try{
  await initDb();
  const q=String(req.nextUrl.searchParams.get("q")||"").trim().slice(0,100);
  const category=String(req.nextUrl.searchParams.get("category")||"").trim().slice(0,100);
  const values:any[]=[];let where="p.status='open' AND p.visibility='public'";
  if(q){values.push("%"+q+"%");where+=" AND (p.title LIKE $"+values.length+" OR p.description LIKE $"+values.length+")";}
  if(category){values.push(category);where+=" AND p.category=$"+values.length;}
  const viewer=await currentCustomer();
  const result=await pool.query("SELECT p.id,p.owner_id,p.title,p.description,p.budget_min,p.budget_max,p.currency,p.delivery_days,p.category,p.skills,p.created_at,c.name AS buyer_name,(SELECT COUNT(*) FROM v_project_bids b WHERE b.project_id=p.id) AS bids_count FROM v_projects p JOIN v_customers c ON c.id=p.owner_id WHERE "+where+" ORDER BY p.created_at DESC LIMIT 50",values);
  return NextResponse.json({projects:result.rows.map((p:any)=>{const {owner_id,...safe}=p;return {...safe,is_owner:!!viewer&&Number(owner_id)===Number(viewer.id)};})},{headers:{"Cache-Control":"no-store"}});
 }catch{return NextResponse.json({error:"تعذر تحميل المشاريع."},{status:500});}
}
export async function POST(req:NextRequest){
 const customer=await currentCustomer();if(!customer)return NextResponse.json({error:"يجب تسجيل الدخول أولاً."},{status:401});
 try{
  await initDb();
  const account=await pool.query("SELECT account_type,email_verified_at FROM v_customers WHERE id=$1",[customer.id]);
  const user=account.rows[0];if(!user?.email_verified_at)return NextResponse.json({error:"أكد بريدك الإلكتروني أولاً."},{status:403});
  if(!["buyer","both","company"].includes(user.account_type))return NextResponse.json({error:"هذا الإجراء متاح لحساب المشتري فقط."},{status:403});
  const body=await req.json();
  const title=String(body.title||"").trim().slice(0,180),description=String(body.description||"").trim().slice(0,12000),category=String(body.category||"").trim().slice(0,100),currency=String(body.currency||"USD").toUpperCase();
  const min=body.budgetMin==null?null:Number(body.budgetMin),max=body.budgetMax==null?null:Number(body.budgetMax),days=body.deliveryDays==null?null:Number(body.deliveryDays);
  const skills=Array.isArray(body.skills)?body.skills.slice(0,10).map((x:any)=>String(x).trim().slice(0,40)).filter(Boolean):[];
  if(title.length<8||description.length<30||!category||!["USD","USDT","USDC"].includes(currency))return NextResponse.json({error:"أكمل عنوان المشروع ووصفه والتصنيف والعملة."},{status:400});
  if((min!==null&&(!Number.isFinite(min)||min<0))||(max!==null&&(!Number.isFinite(max)||max<0))||(min!==null&&max!==null&&min>max)||(days!==null&&(!Number.isInteger(days)||days<1||days>365)))return NextResponse.json({error:"الميزانية أو مدة التنفيذ غير صحيحة."},{status:400});
  const result=await pool.query("INSERT INTO v_projects(owner_id,title,description,budget_min,budget_max,currency,delivery_days,category,skills,visibility,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'public','open')",[customer.id,title,description,min,max,currency,days,category,JSON.stringify(skills)]);
  return NextResponse.json({ok:true,projectId:result.insertId,status:"open"},{status:201});
 }catch{return NextResponse.json({error:"تعذر نشر المشروع."},{status:500});}
}