import {NextRequest,NextResponse} from "next/server";
import {pool,initDb} from "@/lib/db";
export const dynamic="force-dynamic";
export async function GET(req:NextRequest){
 try{await initDb();const q=String(req.nextUrl.searchParams.get("q")||"").trim().slice(0,100);const values:any[]=[];let where="c.account_type IN ('freelancer','both') AND c.email_verified_at IS NOT NULL";if(q){values.push("%"+q+"%");where+=" AND (c.name LIKE $"+values.length+" OR c.username LIKE $"+values.length+" OR c.bio LIKE $"+values.length+")";}const r=await pool.query("SELECT c.id,c.name,c.username,c.bio,c.skills,c.created_at,(SELECT COUNT(*) FROM v_freelancer_services s WHERE s.seller_id=c.id AND s.status='active') AS active_services FROM v_customers c WHERE "+where+" ORDER BY active_services DESC,c.created_at DESC LIMIT 50",values);return NextResponse.json({freelancers:r.rows},{headers:{"Cache-Control":"no-store"}});
 }catch{return NextResponse.json({error:"تعذر تحميل المستقلين."},{status:500});}
}