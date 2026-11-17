import {NextRequest,NextResponse} from "next/server";
import {currentCustomer} from "@/lib/customer-auth";
import {initDb,pool,withTransaction} from "@/lib/db";
import {assertEscrowlyReady,ensureEscrowlySchema,readEscrowlyTransaction,sameMoney,validEscrowlyStatus} from "@/lib/escrowly";
export const dynamic="force-dynamic";
export async function GET(_req:NextRequest,{params}:{params:Promise<{id:string}>}){
 const customer=await currentCustomer();if(!customer)return NextResponse.json({error:"login_required"},{status:401});
 try{
  await initDb();await ensureEscrowlySchema();const {mode}=assertEscrowlyReady();const {id}=await params;const orderId=Number(id);
  if(!Number.isSafeInteger(orderId)||orderId<1)return NextResponse.json({error:"invalid_order"},{status:400});
  const found=await pool.query("SELECT * FROM v_freelance_orders WHERE id=$1 AND (buyer_id=$2 OR seller_id=$2) LIMIT 1",[orderId,customer.id]);const order=found.rows[0];
  if(!order)return NextResponse.json({error:"order_not_found"},{status:404});
  if(!order.escrow_transaction_id)return NextResponse.json({orderId,status:order.status,escrowStatus:order.escrow_status,manualReviewRequired:order.status==="payment_creation_uncertain"},{headers:{"Cache-Control":"no-store"}});
  if(String(order.escrow_mode)!==mode)return NextResponse.json({error:"escrow_mode_mismatch"},{status:409});
  const remote:any=await readEscrowlyTransaction(String(order.escrow_transaction_id));
  if(String(remote?.id)!==String(order.escrow_transaction_id)||!validEscrowlyStatus(remote?.status)||String(remote?.mode||mode)!==mode||
    String(remote?.currency||"").toUpperCase()!==String(process.env.ESCROWLY_CURRENCY||"USDT").toUpperCase()||
    !sameMoney(remote?.amount,Number(order.total)*Number(process.env.ESCROWLY_USD_RATE||"1"))||
    String(remote?.metadata?.freelance_order_id||"")!==String(order.id)||String(remote?.metadata?.order_ref||"")!==String(order.order_ref))
    return NextResponse.json({error:"escrow_reconciliation_failed"},{status:409});
  const map:Record<string,string>={funded:"funded",completed:"completed",disputed:"disputed",refunded:"refunded",resolved:"resolution_pending",cancelled:"cancelled",expired:"cancelled"};
  const next=map[String(remote.status)]||String(order.status);
  await withTransaction(async connection=>{
    await connection.execute("UPDATE v_freelance_orders SET escrow_status=?,status=CASE WHEN status IN ('disputed','refunded','completed','cancelled','payment_creation_uncertain') THEN status ELSE ? END WHERE id=?",[String(remote.status),next,orderId]);
    if(remote.status==="funded"&&order.status==="awaiting_payment"&&order.project_id&&order.bid_id){
      await connection.execute("UPDATE v_project_bids SET status='accepted',updated_at=NOW() WHERE id=? AND project_id=? AND status IN ('pending','awaiting_payment')",[order.bid_id,order.project_id]);
      await connection.execute("UPDATE v_project_bids SET status='rejected',updated_at=NOW() WHERE project_id=? AND id<>? AND status IN ('pending','awaiting_payment')",[order.project_id,order.bid_id]);
      await connection.execute("UPDATE v_projects SET status='in_progress',updated_at=NOW() WHERE id=? AND status='open'",[order.project_id]);
    }
    if((remote.status==="cancelled"||remote.status==="expired")&&order.project_id&&order.bid_id)
      await connection.execute("UPDATE v_project_bids SET status='pending',updated_at=NOW() WHERE id=? AND status='awaiting_payment'",[order.bid_id]);
    if(String(order.escrow_status)!==String(remote.status))
      await connection.execute("INSERT INTO v_freelance_order_events(order_id,actor,from_status,to_status,note) VALUES(?,'system',?,?,?)",[orderId,String(order.status),next,"تم تحديث حالة الضمان من استعلام Escrowly"]);
  });
  return NextResponse.json({orderId,status:next,escrowStatus:remote.status,mode},{headers:{"Cache-Control":"no-store"}});
 }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"escrow_status_unavailable"},{status:503,headers:{"Cache-Control":"no-store"}});}
}
