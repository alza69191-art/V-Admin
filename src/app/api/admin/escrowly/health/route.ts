import {NextResponse} from "next/server";
import {isAdmin} from "@/lib/auth";

export const dynamic="force-dynamic";

export async function GET(){
  if(!await isAdmin()) return NextResponse.json({ok:false,error:"unauthorized"},{status:401});
  const key=process.env.ESCROWLY_API_KEY;
  if(!key) return NextResponse.json({ok:false,mode:"unconfigured",error:"ESCROWLY_API_KEY_MISSING"},{status:503});
  if(!key.startsWith("ek_test_")) return NextResponse.json({ok:false,mode:"blocked",error:"TEST_KEY_REQUIRED",message:"Live keys are blocked by this diagnostic endpoint."},{status:409});
  try{
    const response=await fetch("https://api.escrowly.com/api/v1/connect/transactions?limit=1&page=1",{
      method:"GET",
      headers:{"X-Api-Key":key,"Accept":"application/json"},
      cache:"no-store",
      signal:AbortSignal.timeout(12000)
    });
    const data=await response.json().catch(()=>null);
    if(!response.ok) return NextResponse.json({ok:false,mode:"test",providerStatus:response.status,error:"ESCROWLY_AUTH_OR_API_ERROR",message:typeof data?.message==="string"?data.message:"Escrowly rejected the test API request."},{status:502});
    return NextResponse.json({ok:true,provider:"Escrowly Connect",mode:"test",authentication:"valid",readOnly:true,transactionsFound:Number(data?.total??data?.data?.length??0)},{headers:{"Cache-Control":"no-store"}});
  }catch{
    return NextResponse.json({ok:false,mode:"test",error:"ESCROWLY_UNREACHABLE"},{status:502});
  }
}
