import {NextRequest,NextResponse} from "next/server";
import {randomBytes} from "node:crypto";
import {pool,initDb,withTransaction} from "@/lib/db";
import {currentCustomer} from "@/lib/customer-auth";
import {enforceRateLimit} from "@/lib/rate-limit";
import {assertEscrowlyReady} from "@/lib/escrowly";

export const dynamic="force-dynamic";

export async function GET(){
  const customer=await currentCustomer();
  if(!customer)return NextResponse.json({error:"login_required"},{status:401});
  try{
    await initDb();
    const rate=await enforceRateLimit(req,"orders-create",10,900,String(customer.id));
    if(!rate.allowed)return NextResponse.json({error:"تم تجاوز عدد المحاولات المسموح. حاول لاحقاً."},{status:429,headers:{"Retry-After":String(rate.retryAfter),"Cache-Control":"no-store"}});
    const orders=await pool.query("SELECT id,order_number,status,currency,total,created_at FROM v_orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 50",[customer.id]);
    if(!orders.rows.length)return NextResponse.json([]);
    const ids=orders.rows.map((x:any)=>Number(x.id));
    const items=await pool.query(`SELECT id,order_id,title_snapshot,unit_price,quantity,line_total,currency FROM v_order_items WHERE order_id IN (${ids.map((_,i)=>"$"+(i+1)).join(",")}) ORDER BY id ASC`,ids);
    const grouped=new Map<number,any[]>();
    for(const item of items.rows){const id=Number(item.order_id);if(!grouped.has(id))grouped.set(id,[]);grouped.get(id)!.push(item);}
    return NextResponse.json(orders.rows.map((o:any)=>({...o,items:grouped.get(Number(o.id))||[]})));
  }catch{return NextResponse.json({error:"تعذر تحميل الطلبات"},{status:503});}
}

export async function POST(req:NextRequest){
  const origin=req.headers.get("origin");
  if(process.env.NODE_ENV==="production" && origin!=="https://v-storefront.onrender.com") return NextResponse.json({error:"origin_not_allowed"},{status:403});
  const customer=await currentCustomer();
  if(!customer) return NextResponse.json({error:"login_required"},{status:401});
  try{
    await initDb();
    const body=await req.json();
    const paymentMethod=String(body.paymentMethod||"manual");
    if(paymentMethod!=="manual"&&paymentMethod!=="escrowly") return NextResponse.json({error:"invalid_payment_method"},{status:400});
    if(paymentMethod==="escrowly"){
      try { assertEscrowlyReady(); }
      catch(error) { return NextResponse.json({error:error instanceof Error?error.message:"escrowly_not_configured"},{status:503}); }
    }
    if(!Array.isArray(body.items)||body.items.length<1||body.items.length>30) return NextResponse.json({error:"invalid_cart"},{status:400});
    const quantities=new Map<number,number>();
    for(const item of body.items){
      const id=Number(item?.productId),qty=Number(item?.quantity);
      if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(qty)||qty<1||qty>50) return NextResponse.json({error:"invalid_cart_item"},{status:400});
      quantities.set(id,(quantities.get(id)||0)+qty);
    }
    if([...quantities.values()].some(q=>q>50)) return NextResponse.json({error:"quantity_limit"},{status:400});
    const user=await pool.query("SELECT id,name,email FROM v_customers WHERE id=$1 LIMIT 1",[customer.id]);
    if(!user.rows[0]) return NextResponse.json({error:"login_required"},{status:401});
    const order=await withTransaction(async connection=>{
      const ids=[...quantities.keys()];
      const [rows]=await connection.execute<any[]>(`SELECT id,title,price,currency,stock,status FROM v_products WHERE id IN (${ids.map(()=>"?").join(",")}) FOR UPDATE`,ids);
      if(rows.length!==ids.length) throw new Error("PRODUCT_NOT_FOUND");
      const currency=String(rows[0].currency||"USD").toUpperCase();
      let totalCents=0;
      const lines:any[]=[];
      for(const product of rows){
        const qty=quantities.get(Number(product.id))||0;
        if(product.status!=="published") throw new Error("PRODUCT_UNAVAILABLE");
        if(String(product.currency||"USD").toUpperCase()!==currency) throw new Error("MIXED_CURRENCY");
        if(Number(product.stock)<qty) throw new Error("INSUFFICIENT_STOCK");
        const unitCents=Math.round(Number(product.price)*100);
        if(!Number.isFinite(unitCents)||unitCents<0) throw new Error("INVALID_PRICE");
        totalCents+=unitCents*qty;
        lines.push({product,qty,unitCents});
      }
      if(paymentMethod==="escrowly"&&currency!=="USD") throw new Error("ESCROWLY_USD_ONLY");
      
      const orderNumber="VC-"+Date.now().toString(36).toUpperCase()+"-"+randomBytes(3).toString("hex").toUpperCase();
      const [insertResult]=await connection.execute<any>("INSERT INTO v_orders(order_number,customer_id,customer_name,customer_email,status,currency,total,stock_reserved) VALUES(?,?,?,?,'pending',?,?,1)",[orderNumber,customer.id,user.rows[0].name,user.rows[0].email,currency,totalCents/100]);
      const orderId=Number(insertResult.insertId);
      for(const line of lines){
        await connection.execute("UPDATE v_products SET stock=stock-?,updated_at=NOW() WHERE id=? AND stock>=?",[line.qty,line.product.id,line.qty]);
        await connection.execute("INSERT INTO v_order_items(order_id,product_id,title_snapshot,unit_price,quantity,line_total,currency) VALUES(?,?,?,?,?,?,?)",[orderId,line.product.id,line.product.title,line.unitCents/100,line.qty,line.unitCents*line.qty/100,currency]);
      }
      await connection.execute("INSERT INTO v_order_events(order_id,actor,from_status,to_status,note) VALUES(?,'customer',NULL,'pending','تم إنشاء الطلب بانتظار مراجعة المتجر')",[orderId]);
      return {id:orderId,orderNumber,total:totalCents/100,currency};
    });
    return NextResponse.json({ok:true,order,paymentMethod,paymentStatus:"unpaid",message:paymentMethod==="escrowly"?"تم إنشاء الطلب؛ تابع إلى صفحة الضمان لإيداع المبلغ.":"تم استلام طلبك وهو بانتظار تأكيد المتجر. لم يتم تحصيل أي مبلغ."},{status:201});
  }catch(error){
    const code=error instanceof Error?error.message:"";
    const messages:Record<string,string>={ESCROWLY_USD_ONLY:"طلبات الضمان تتطلب أن تكون أسعار المنصة بالدولار الأمريكي حالياً.",PRODUCT_NOT_FOUND:"أحد المنتجات لم يعد متاحاً.",PRODUCT_UNAVAILABLE:"أحد المنتجات غير منشور حالياً.",MIXED_CURRENCY:"لا يمكن جمع منتجات بعملات مختلفة في طلب واحد.",INSUFFICIENT_STOCK:"الكمية المطلوبة غير متوفرة في المخزون.",INVALID_PRICE:"تعذر اعتماد سعر أحد المنتجات."};
    const status=code==="INSUFFICIENT_STOCK"?409:code==="PRODUCT_NOT_FOUND"||code==="PRODUCT_UNAVAILABLE"?409:code==="MIXED_CURRENCY"||code==="INVALID_PRICE"||code==="ESCROWLY_USD_ONLY"?400:500;
    return NextResponse.json({error:messages[code]||"تعذر إنشاء الطلب. حاول مرة أخرى."},{status});
  }
}