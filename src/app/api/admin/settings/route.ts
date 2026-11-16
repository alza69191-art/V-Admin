import {NextRequest,NextResponse} from "next/server";
import {isAdmin} from "@/lib/auth";
import {pool,initDb} from "@/lib/db";
export async function PUT(req:NextRequest){
 if(!await isAdmin())return NextResponse.json({error:"unauthorized"},{status:401});
 try{
  await initDb();
  const body=await req.json();
  for(const [key,value] of Object.entries(body)){
   if(typeof key!=="string"||key.length>80)continue;
   await pool.query("INSERT INTO v_settings(`key`,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[key,JSON.stringify(value)]);
   await pool.query("INSERT INTO v_audit(actor,action,entity) VALUES('admin','settings.updated',$1)",[key]);
  }
  return NextResponse.json({ok:true});
 }catch{return NextResponse.json({error:"save_failed"},{status:500});}
}