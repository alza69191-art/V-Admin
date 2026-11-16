import {NextRequest,NextResponse} from "next/server";
import {issueSession} from "@/lib/auth";

export const dynamic="force-dynamic";

export async function POST(req:NextRequest){
  const body=await req.json().catch(()=>({password:""}));
  const password=typeof body?.password==="string"?body.password:"";
  if(!process.env.ADMIN_PASSWORD || password!==process.env.ADMIN_PASSWORD){
    return NextResponse.json({ok:false,error:"بيانات الدخول غير صحيحة"},{status:401,headers:{"Cache-Control":"no-store"}});
  }
  const token=await issueSession();
  const res=NextResponse.json({ok:true},{headers:{"Cache-Control":"no-store"}});
  res.cookies.set({
    name:"v_admin_session",
    value:token,
    httpOnly:true,
    secure:req.nextUrl.protocol==="https:",
    sameSite:"lax",
    path:"/",
    maxAge:28800
  });
  return res;
}
