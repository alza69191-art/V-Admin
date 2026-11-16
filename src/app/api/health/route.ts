import {NextResponse} from "next/server";
import {pool,initDb} from "@/lib/db";

export const dynamic="force-dynamic";

export async function GET(){
  try{
    await initDb();
    await pool.query("SELECT 1 AS ok");
    return NextResponse.json({status:"ok",database:"connected"},{headers:{"Cache-Control":"no-store"}});
  }catch{
    return NextResponse.json({status:"error",database:"unavailable"},{status:503,headers:{"Cache-Control":"no-store"}});
  }
}
