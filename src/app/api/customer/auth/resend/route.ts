import {NextRequest,NextResponse} from "next/server";
import {createHash,randomInt} from "crypto";
import {pool,initDb} from "@/lib/db";
import {verifyTurnstile} from "@/lib/turnstile";
import {enforceRateLimit} from "@/lib/rate-limit";
export const dynamic="force-dynamic";
export async function POST(req:NextRequest){
 try{
  await initDb();
  const body=await req.json().catch(()=>({}));
  if(!await verifyTurnstile(String(body.turnstileToken||"")))return NextResponse.json({error:"أكمل اختبار الحماية ثم أعد المحاولة."},{status:403});
  const email=String(body.email||"").trim().toLowerCase();
  const rate=await enforceRateLimit(req,"customer-resend",3,3600,email);
  if(!rate.allowed)return NextResponse.json({error:"تم تجاوز عدد المحاولات المسموح. حاول لاحقاً."},{status:429,headers:{"Retry-After":String(rate.retryAfter),"Cache-Control":"no-store"}});
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return NextResponse.json({error:"أدخل بريداً صحيحاً."},{status:400});
  const found=await pool.query("SELECT id,name,email,email_verified_at FROM v_customers WHERE email=$1 LIMIT 1",[email]);
  const user=found.rows[0];
  if(!user||user.email_verified_at)return NextResponse.json({ok:true,message:"إذا كان الحساب بحاجة إلى تأكيد، فسيصلك رمز جديد."});
  if(!process.env.RESEND_API_KEY||!process.env.RESEND_FROM_EMAIL)return NextResponse.json({error:"خدمة البريد غير مهيأة."},{status:503});
  const recent=await pool.query("SELECT id FROM v_customer_verifications WHERE customer_id=$1 AND created_at>DATE_SUB(NOW(),INTERVAL 60 SECOND) LIMIT 1",[user.id]);
  if(recent.rows.length)return NextResponse.json({error:"انتظر دقيقة قبل طلب رمز جديد."},{status:429});
  const code=String(randomInt(0,1000000)).padStart(6,"0");
  const digest=createHash("sha256").update(code).digest("hex");
  await pool.query("INSERT INTO v_customer_verifications(customer_id,code_hash,expires_at) VALUES($1,$2,DATE_ADD(NOW(),INTERVAL 15 MINUTE))",[user.id,digest]);
  const safeName=String(user.name).replace(/[<>&"]/g,"");
  const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Authorization":"Bearer "+process.env.RESEND_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({from:process.env.RESEND_FROM_EMAIL,to:[email],subject:"رمز تأكيد البريد الإلكتروني",html:`<div dir="rtl"><h2>مرحباً ${safeName}</h2><p>رمز التأكيد: <strong>${code}</strong></p><p>تنتهي صلاحيته خلال 15 دقيقة.</p></div>`}),signal:AbortSignal.timeout(12000)});
  if(!response.ok)return NextResponse.json({error:"تعذر إرسال الرمز حالياً."},{status:502});
  return NextResponse.json({ok:true,message:"أرسلنا رمز تأكيد جديداً."});
 }catch{return NextResponse.json({error:"تعذر تنفيذ الطلب."},{status:500});}
}