import {NextRequest,NextResponse} from "next/server";
import {createHash} from "crypto";
import {pool,initDb} from "@/lib/db";
import {verifyTurnstile} from "@/lib/turnstile";
import {issueCustomerSession} from "@/lib/customer-auth";
export const dynamic="force-dynamic";
export async function POST(req:NextRequest){
 try{
  await initDb();
  const body=await req.json().catch(()=>({}));
  if(!await verifyTurnstile(String(body.turnstileToken||"")))return NextResponse.json({error:"أكمل اختبار الحماية ثم أعد المحاولة."},{status:403});
  const email=String(body.email||"").trim().toLowerCase();
  const code=String(body.code||"").trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!/^\d{6}$/.test(code))return NextResponse.json({error:"أدخل البريد ورمز التأكيد المكوّن من 6 أرقام."},{status:400});
  const digest=createHash("sha256").update(code).digest("hex");
  const found=await pool.query("SELECT c.id,c.name,c.email,c.account_type,v.id AS verification_id FROM v_customers c JOIN v_customer_verifications v ON v.customer_id=c.id WHERE c.email=$1 AND v.code_hash=$2 AND v.consumed_at IS NULL AND v.expires_at>NOW() AND v.attempts<10 ORDER BY v.id DESC LIMIT 1",[email,digest]);
  const user=found.rows[0];
  if(!user){
   const pending=await pool.query("SELECT v.id FROM v_customer_verifications v JOIN v_customers c ON c.id=v.customer_id WHERE c.email=$1 AND v.consumed_at IS NULL AND v.expires_at>NOW() ORDER BY v.id DESC LIMIT 1",[email]);
   if(pending.rows[0])await pool.query("UPDATE v_customer_verifications SET attempts=attempts+1 WHERE id=$1",[pending.rows[0].id]);
   return NextResponse.json({error:"رمز التأكيد غير صحيح أو منتهي الصلاحية."},{status:400});
  }
  await pool.query("UPDATE v_customer_verifications SET consumed_at=NOW() WHERE id=$1",[user.verification_id]);
  await pool.query("UPDATE v_customers SET email_verified_at=NOW() WHERE id=$1",[user.id]);
  const token=await issueCustomerSession(Number(user.id));
  const res=NextResponse.json({ok:true,user:{id:user.id,name:user.name,email:user.email,accountType:user.account_type}},{headers:{"Cache-Control":"no-store"}});
  res.cookies.set({name:"v_customer_session",value:token,httpOnly:true,secure:req.nextUrl.protocol==="https:",sameSite:"none",path:"/",maxAge:2592000});
  return res;
 }catch{return NextResponse.json({error:"تعذر تأكيد البريد حالياً."},{status:500});}
}