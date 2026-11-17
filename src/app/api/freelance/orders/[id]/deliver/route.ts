import {NextResponse} from "next/server";
import {currentCustomer} from "@/lib/customer-auth";
import {initDb,pool} from "@/lib/db";
import {assertEscrowlyReady,ensureEscrowlySchema,markEscrowlyDelivered,readEscrowlyTransaction,sameMoney} from "@/lib/escrowly";
export const dynamic="force-dynamic";
export async function POST(_req:Request,{params}:{params:Promise<{id:string}>}){
 const customer=await currentCustomer();if(!customer)return NextResponse.json({error:"login_required"},{status:401});
 try{
  await initDb();await ensureEscrowlySchema();assertEscrowlyReady();
  const {id}=await params;const orderId=Number(id);if(!Number.isSafeInteger(orderId)||orderId<1)return NextResponse.json({error:"invalid_order"},{status:400});
  const found=await pool.query("SELECT * FROM v_freelance_orders WHERE id=$1 LIMIT 1",[orderId]);const order=found.rows[0];
  if(!order||Number(order.seller_id)!==Number(customer.id))return NextResponse.json({error:"order_not_found"},{status:404});
  if(!order.escrow_transaction_id||!["funded","in_progress"].includes(String(order.status)))return NextResponse.json({error:"لا يمكن تسليم العمل قبل تأكيد حجز المبلغ."},{status:409});
  const before=String(order.status);
  await markEscrowlyDelivered(String(order.escrow_transaction_id));
  const remote:any=await readEscrowlyTransaction(String(order.escrow_transaction_id));
  if(String(remote?.id)!==String(order.escrow_transaction_id)||!sameMoney(remote?.amount,Number(order.total)*Number(process.env.ESCROWLY_USD_RATE||"1"))||String(remote?.currency||"").toUpperCase()!==String(process.env.ESCROWLY_CURRENCY||"USDT").toUpperCase()||String(remote?.metadata?.freelance_order_id||"")!==String(order.id))
   return NextResponse.json({error:"تعذر مطابقة معاملة الضمان بعد تسجيل التسليم."},{status:409});
  await pool.query("UPDATE v_freelance_orders SET status='delivered',escrow_status=$1,delivered_at=NOW() WHERE id=$2",[String(remote.status||"inspection_expiring"),orderId]);
  await pool.query("INSERT INTO v_freelance_order_events(order_id,actor,from_status,to_status,note) VALUES($1,'seller',$2,'delivered','سجّل المستقل تسليم العمل وأُبلغ مزود الضمان')",[orderId,before]);
  return NextResponse.json({ok:true,status:"delivered",escrowStatus:remote.status||null,inspectionDays:Number(process.env.ESCROWLY_INSPECTION_DAYS||"3")},{headers:{"Cache-Control":"no-store"}});
 }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"delivery_failed"},{status:502});}
}
