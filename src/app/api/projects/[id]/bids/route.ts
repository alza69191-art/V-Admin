import {NextRequest,NextResponse} from "next/server";
import {pool,initDb} from "@/lib/db";
import {currentCustomer} from "@/lib/customer-auth";
export const dynamic="force-dynamic";
export async function POST(req:NextRequest,{params}:{params:Promise<{id:string}>}){
 const customer=await currentCustomer();if(!customer)return NextResponse.json({error:"يجب تسجيل الدخول أولاً."},{status:401});
 try{
  await initDb();
  const {id}=await params;const projectId=Number(id);
  if(!Number.isSafeInteger(projectId)||projectId<1)return NextResponse.json({error:"المشروع غير صحيح."},{status:400});
  const [account,project]=await Promise.all([pool.query("SELECT account_type,email_verified_at FROM v_customers WHERE id=$1",[customer.id]),pool.query("SELECT id,owner_id,status,currency FROM v_projects WHERE id=$1",[projectId])]);
  const user=account.rows[0],target=project.rows[0];
  if(!user?.email_verified_at)return NextResponse.json({error:"أكد بريدك الإلكتروني أولاً."},{status:403});
  if(!["freelancer","both"].includes(user.account_type))return NextResponse.json({error:"تقديم العروض متاح لحساب المستقل فقط."},{status:403});
  if(!target||target.status!=="open")return NextResponse.json({error:"المشروع غير متاح لاستقبال العروض."},{status:404});
  if(Number(target.owner_id)===customer.id)return NextResponse.json({error:"لا يمكنك تقديم عرض على مشروعك."},{status:400});
  const body=await req.json();const amount=Number(body.amount),days=Number(body.deliveryDays),proposal=String(body.proposal||"").trim().slice(0,6000);
  if(!Number.isFinite(amount)||amount<=0||!Number.isInteger(days)||days<1||days>365||proposal.length<30)return NextResponse.json({error:"أدخل سعراً ومدة تنفيذ وعرضاً تفصيلياً صالحاً."},{status:400});
  const result=await pool.query("INSERT INTO v_project_bids(project_id,freelancer_id,amount,currency,delivery_days,proposal,status) VALUES($1,$2,$3,$4,$5,$6,'pending')",[projectId,customer.id,amount,target.currency,days,proposal]);
  return NextResponse.json({ok:true,bidId:result.insertId,status:"pending"},{status:201});
 }catch(error:any){if(String(error?.code)==="ER_DUP_ENTRY")return NextResponse.json({error:"لديك عرض مسجل بالفعل على هذا المشروع."},{status:409});return NextResponse.json({error:"تعذر تقديم العرض."},{status:500});}
}