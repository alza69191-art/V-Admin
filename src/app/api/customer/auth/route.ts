import {NextRequest,NextResponse} from "next/server";
import bcrypt from "bcryptjs";
import {createHash,randomInt} from "crypto";
import {pool,initDb} from "@/lib/db";
import {verifyTurnstile} from "@/lib/turnstile";
import {enforceRateLimit} from "@/lib/rate-limit";
import {issueCustomerSession,currentCustomer} from "@/lib/customer-auth";

export const dynamic="force-dynamic";
const hashCode=(value:string)=>createHash("sha256").update(value).digest("hex");
async function sendVerification(email:string,name:string,code:string){
 const apiKey=process.env.RESEND_API_KEY;
 const from=process.env.RESEND_FROM_EMAIL;
 if(!apiKey||!from) throw new Error("EMAIL_PROVIDER_NOT_CONFIGURED");
 const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Authorization":"Bearer "+apiKey,"Content-Type":"application/json"},body:JSON.stringify({from,to:[email],subject:"تأكيد بريدك الإلكتروني",html:`<div dir="rtl" style="font-family:Arial,sans-serif"><h2>مرحباً ${name.replace(/[<>&"]/g,"")}</h2><p>رمز تأكيد البريد الإلكتروني:</p><div style="font-size:30px;font-weight:bold;letter-spacing:8px">${code}</div><p>تنتهي صلاحية الرمز خلال 15 دقيقة. لا تشاركه مع أي شخص.</p></div>`}),signal:AbortSignal.timeout(12000)});
 if(!response.ok) throw new Error("EMAIL_DELIVERY_FAILED");
}
export async function GET(){
 const c=await currentCustomer();
 if(!c)return NextResponse.json({user:null},{headers:{"Cache-Control":"no-store"}});
 await initDb();
 const r=await pool.query("SELECT id,name,email,account_type,username,bio,skills,email_verified_at FROM v_customers WHERE id=$1",[c.id]);
 return NextResponse.json({user:r.rows[0]||null},{headers:{"Cache-Control":"no-store"}});
}
export async function POST(req:NextRequest){
 try{
  await initDb();
  const body=await req.json().catch(()=>({}));
  const action=String(body.action||"");
  if(process.env.TURNSTILE_SECRET_KEY){if(!await verifyTurnstile(String(body.turnstileToken||"")))return NextResponse.json({error:"أكمل اختبار الحماية ثم أعد المحاولة."},{status:403});}
  else if(action!=="login")return NextResponse.json({error:"التسجيل والتحقق متوقفان مؤقتاً حتى تفعيل Cloudflare Turnstile."},{status:503});
  const normalized=String(body.email||"").trim().toLowerCase();
  const rate=await enforceRateLimit(req,"customer-auth",12,900,normalized);
  if(!rate.allowed)return NextResponse.json({error:"تم تجاوز عدد المحاولات المسموح. حاول لاحقاً."},{status:429,headers:{"Retry-After":String(rate.retryAfter),"Cache-Control":"no-store"}});
  const password=String(body.password||"");
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)||password.length<1||password.length>128)
   return NextResponse.json({error:"أدخل بريداً صحيحاً وكلمة مرور صالحة."},{status:400});
  let user:any;
  if(action==="register"){
   if(password.length<10)return NextResponse.json({error:"كلمة المرور يجب ألا تقل عن 10 أحرف."},{status:400});
   const name=String(body.name||"").trim().slice(0,120);
   const accountType=String(body.accountType||"buyer");
   if(name.length<2||!["buyer","freelancer","both"].includes(accountType))
    return NextResponse.json({error:"أدخل الاسم وحدد نوع الحساب"},{status:400});
   if(!process.env.RESEND_API_KEY||!process.env.RESEND_FROM_EMAIL)
    return NextResponse.json({error:"تأكيد البريد غير مهيأ بعد. يلزم إعداد خدمة البريد قبل فتح التسجيل."},{status:503});
   const passwordHash=await bcrypt.hash(password,12);
   try{
    const result=await pool.query("INSERT INTO v_customers(name,email,password_hash,account_type) VALUES($1,$2,$3,$4)",[name,normalized,passwordHash,accountType]);
    const id=Number(result.insertId);
    const code=String(randomInt(0,1000000)).padStart(6,"0");
    await pool.query("INSERT INTO v_customer_verifications(customer_id,code_hash,expires_at) VALUES($1,$2,DATE_ADD(NOW(),INTERVAL 15 MINUTE))",[id,hashCode(code)]);
    await sendVerification(normalized,name,code);
    return NextResponse.json({ok:true,requiresVerification:true,email:normalized,message:"أرسلنا رمز التأكيد إلى بريدك الإلكتروني."},{status:201,headers:{"Cache-Control":"no-store"}});
   }catch(error:any){
    if(String(error?.message)==="EMAIL_PROVIDER_NOT_CONFIGURED")return NextResponse.json({error:"خدمة البريد غير مهيأة."},{status:503});
    if(String(error?.message)==="EMAIL_DELIVERY_FAILED")return NextResponse.json({error:"تعذر إرسال رمز التأكيد. يمكنك إعادة المحاولة لاحقاً."},{status:502});
    if(String(error?.code)==="ER_DUP_ENTRY")return NextResponse.json({error:"البريد الإلكتروني مستخدم بالفعل"},{status:409});
    throw error;
   }
  }
  if(action==="login"){
   const r=await pool.query("SELECT * FROM v_customers WHERE email=$1 LIMIT 1",[normalized]);
   user=r.rows[0];
   if(!user||!(await bcrypt.compare(password,user.password_hash)))return NextResponse.json({error:"بيانات الدخول غير صحيحة"},{status:401});
   if(!user.email_verified_at)return NextResponse.json({error:"أكد بريدك الإلكتروني قبل تسجيل الدخول."},{status:403,headers:{"Cache-Control":"no-store"}});
   await pool.query("UPDATE v_customers SET last_login=NOW() WHERE id=$1",[user.id]);
  }else return NextResponse.json({error:"invalid_action"},{status:400});
  const token=await issueCustomerSession(Number(user.id));
  const res=NextResponse.json({user:{id:user.id,name:user.name,email:user.email,accountType:user.account_type}},{headers:{"Cache-Control":"no-store"}});
  res.cookies.set({name:"v_customer_session",value:token,httpOnly:true,secure:req.nextUrl.protocol==="https:",sameSite:"none",path:"/",maxAge:2592000});
  return res;
 }catch{return NextResponse.json({error:"تعذر إكمال العملية"},{status:500});}
}
export async function DELETE(){
 const res=NextResponse.json({ok:true},{headers:{"Cache-Control":"no-store"}});
 res.cookies.set({name:"v_customer_session",value:"",httpOnly:true,secure:true,sameSite:"none",path:"/",maxAge:0});
 return res;
}