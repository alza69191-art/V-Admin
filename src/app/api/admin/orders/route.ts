import {NextRequest,NextResponse} from "next/server";
import {pool,initDb,withTransaction} from "@/lib/db";
import {isAdmin} from "@/lib/auth";
export const dynamic="force-dynamic";
const transitions:Record<string,string[]>={pending:["confirmed","cancelled"],confirmed:["processing","cancelled"],processing:["shipped","cancelled"],shipped:["completed"],completed:[],cancelled:[]};
export async function GET(){
 if(!await isAdmin()) return NextResponse.json({error:"unauthorized"},{status:401});
 await initDb();
 const orders=await pool.query("SELECT * FROM v_orders ORDER BY created_at DESC LIMIT 200");
 if(!orders.rows.length)return NextResponse.json([]);
 const ids=orders.rows.map((x:any)=>Number(x.id));
 const items=await pool.query(`SELECT * FROM v_order_items WHERE order_id IN (${ids.map((_,i)=>"$"+(i+1)).join(",")}) ORDER BY id ASC`,ids);
 const grouped=new Map<number,any[]>();
 for(const item of items.rows){const id=Number(item.order_id);if(!grouped.has(id))grouped.set(id,[]);grouped.get(id)!.push(item);}
 return NextResponse.json(orders.rows.map((o:any)=>({...o,items:grouped.get(Number(o.id))||[]})));
}
export async function PATCH(req:NextRequest){
 if(!await isAdmin()) return NextResponse.json({error:"unauthorized"},{status:401});
 try{
  await initDb();
  const body=await req.json(),id=Number(body.id),next=String(body.status||"");
  if(!Number.isSafeInteger(id)||id<1||!Object.prototype.hasOwnProperty.call(transitions,next))return NextResponse.json({error:"invalid_request"},{status:400});
  const result=await withTransaction(async connection=>{
   const [rows]=await connection.execute<any[]>("SELECT * FROM v_orders WHERE id=? FOR UPDATE",[id]);
   const order=rows[0];if(!order)throw new Error("NOT_FOUND");
   if(!transitions[String(order.status)]?.includes(next))throw new Error("INVALID_TRANSITION");
   if(next==="cancelled"&&Number(order.stock_reserved)===1){
    const [lines]=await connection.execute<any[]>("SELECT product_id,quantity FROM v_order_items WHERE order_id=?",[id]);
    for(const line of lines)await connection.execute("UPDATE v_products SET stock=stock+?,updated_at=NOW() WHERE id=?",[line.quantity,line.product_id]);
   }
   await connection.execute("UPDATE v_orders SET status=?,stock_reserved=IF(?='cancelled',0,stock_reserved),updated_at=NOW() WHERE id=?",[next,next,id]);
   await connection.execute("INSERT INTO v_order_events(order_id,actor,from_status,to_status,note) VALUES(?,'admin',?,?,?)",[id,order.status,next,String(body.note||"").slice(0,500)||null]);
   return {id,from:order.status,status:next};
  });
  return NextResponse.json({ok:true,order:result});
 }catch(error){
  const code=error instanceof Error?error.message:"";
  return NextResponse.json({error:code==="NOT_FOUND"?"الطلب غير موجود.":code==="INVALID_TRANSITION"?"انتقال الحالة غير مسموح.":"تعذر تحديث الطلب."},{status:code==="NOT_FOUND"?404:code==="INVALID_TRANSITION"?409:500});
 }
}