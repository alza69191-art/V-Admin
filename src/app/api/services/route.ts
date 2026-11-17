import {NextRequest,NextResponse} from "next/server";
import {randomUUID} from "crypto";
import {pool,initDb} from "@/lib/db";
import {currentCustomer} from "@/lib/customer-auth";
export const dynamic="force-dynamic";
export async function GET(req:NextRequest){
 try{await initDb();const q=String(req.nextUrl.searchParams.get("q")||"").trim().slice(0,100);const category=String(req.nextUrl.searchParams.get("category")||"").trim().slice(0,100);const values:any[]=[];let where="s.status='active'";if(q){values.push("%"+q+"%");where+=" AND (s.title LIKE $"+values.length+" OR s.description LIKE $"+values.length+")";}if(category){values.push(category);where+=" AND s.category=$"+values.length;}const result=await pool.query("SELECT s.id,s.title,s.slug,s.description,s.category,s.price,s.currency,s.delivery_days,s.revisions,s.tags,s.created_at,c.name AS seller_name FROM v_freelancer_services s JOIN v_customers c ON c.id=s.seller_id WHERE "+where+" ORDER BY s.created_at DESC LIMIT 50",values);return NextResponse.json({services:result.rows},{headers:{"Cache-Control":"no-store"}});}catch{return NextResponse.json({error:"تعذر تحميل الخدمات."},{status:500});}
}
export async function POST(req:NextRequest){
 const customer=await currentCustomer();if(!customer)return NextResponse.json({error:"يجب تسجيل الدخول أولاً."},{status:401});
 try{await initDb();const account=await pool.query("SELECT account_type,email_verified_at FROM v_customers WHERE id=$1",[customer.id]);const user=account.rows[0];if(!user?.email_verified_at)return NextResponse.json({error:"أكد بريدك الإلكتروني أولاً."},{status:403});if(!["freelancer","both"].includes(user.account_type))return NextResponse.json({error:"إنشاء الخدمات متاح لحساب المستقل فقط."},{status:403});
 const body=await req.json();const title=String(body.title||"").trim().slice(0,180),description=String(body.description||"").trim().slice(0,10000),category=String(body.category||"").trim().slice(0,100),price=Number(body.price),currency=String(body.currency||"USD").toUpperCase(),deliveryDays=Number(body.deliveryDays),revisions=Number(body.revisions??1),tags=Array.isArray(body.tags)?body.tags.slice(0,10).map((x:any)=>String(x).trim().slice(0,40)).filter(Boolean):[];
 if(title.length<8||description.length<40||!category||!Number.isFinite(price)||price<1||!["USD","USDT","USDC"].includes(currency)||!Number.isInteger(deliveryDays)||deliveryDays<1||deliveryDays>90||!Number.isInteger(revisions)||revisions<0||revisions>20)return NextResponse.json({error:"بيانات الخدمة غير مكتملة أو غير صحيحة."},{status:400});
 const slug=(title.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,150)||"service")+"-"+randomUUID().slice(0,8);
 const result=await pool.query("INSERT INTO v_freelancer_services(seller_id,title,slug,description,category,price,currency,delivery_days,revisions,tags,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')",[customer.id,title,slug,description,category,price,currency,deliveryDays,revisions,JSON.stringify(tags)]);
 return NextResponse.json({ok:true,serviceId:result.insertId,status:"pending",message:"تم إرسال الخدمة للمراجعة قبل نشرها."},{status:201});
 }catch{return NextResponse.json({error:"تعذر إنشاء الخدمة."},{status:500});}
}