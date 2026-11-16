import {NextRequest,NextResponse} from "next/server";
import {pool,initDb} from "@/lib/db";
import {currentCustomer} from "@/lib/customer-auth";
export const dynamic="force-dynamic";
export async function PATCH(req:NextRequest){
 const customer=await currentCustomer();
 if(!customer)return NextResponse.json({error:"unauthorized"},{status:401});
 try{
  await initDb();
  const body=await req.json();
  const username=body.username===undefined?undefined:String(body.username).trim().toLowerCase();
  const bio=body.bio===undefined?undefined:String(body.bio).trim().slice(0,2000);
  const accountType=body.accountType===undefined?undefined:String(body.accountType);\n  if(accountType!==undefined&&!["buyer","freelancer","both"].includes(accountType))return NextResponse.json({error:"نوع الحساب غير صالح."},{status:400});\n  const skills=body.skills===undefined?undefined:(Array.isArray(body.skills)?body.skills.slice(0,20).map((x:any)=>String(x).trim().slice(0,40)).filter(Boolean):null);
  if(username!==undefined&&!/^[a-z0-9_]{3,30}$/.test(username))return NextResponse.json({error:"اسم المستخدم يجب أن يكون 3-30 حرفاً إنجليزياً أو رقماً أو _."},{status:400});
  if(skills===null)return NextResponse.json({error:"قائمة المهارات غير صالحة."},{status:400});
  if(accountType!==undefined)await pool.query("UPDATE v_customers SET account_type=$1 WHERE id=$2",[accountType,customer.id]);\n  if(username!==undefined)await pool.query("UPDATE v_customers SET username=$1 WHERE id=$2",[username,customer.id]);
  if(bio!==undefined)await pool.query("UPDATE v_customers SET bio=$1 WHERE id=$2",[bio,customer.id]);
  if(skills!==undefined)await pool.query("UPDATE v_customers SET skills=$1 WHERE id=$2",[JSON.stringify(skills),customer.id]);
  const result=await pool.query("SELECT id,name,email,account_type,username,bio,skills,email_verified_at FROM v_customers WHERE id=$1",[customer.id]);
  return NextResponse.json({user:result.rows[0]},{headers:{"Cache-Control":"no-store"}});
 }catch(error:any){
  if(String(error?.code)==="ER_DUP_ENTRY")return NextResponse.json({error:"اسم المستخدم مستخدم بالفعل."},{status:409});
  return NextResponse.json({error:"تعذر حفظ الملف الشخصي."},{status:500});
 }
}