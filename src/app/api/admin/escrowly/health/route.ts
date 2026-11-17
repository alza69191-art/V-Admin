import {NextResponse} from "next/server";
import {isAdmin} from "@/lib/auth";
import {assertEscrowlyReady,escrowlyMode} from "@/lib/escrowly";

export const dynamic="force-dynamic";

export async function GET(){
  if(!await isAdmin()) return NextResponse.json({ok:false,error:"unauthorized"},{status:401});
  const mode=escrowlyMode();
  if(!mode) return NextResponse.json({ok:false,mode:"unconfigured",error:"ESCROWLY_API_KEY_MISSING"},{status:503});
  if(mode==="live"&&process.env.ESCROWLY_LIVE_ENABLED!=="true") {
    return NextResponse.json({ok:false,mode:"live",liveEnabled:false,error:"LIVE_MODE_LOCKED",message:"Production transactions remain locked until test verification is complete."},{status:409});
  }
  try{
    const {key}=assertEscrowlyReady();
    const response=await fetch("https://api.escrowly.com/api/v1/connect/transactions?limit=1&page=1",{
      method:"GET",
      headers:{"X-Api-Key":key,"Accept":"application/json"},
      cache:"no-store",
      signal:AbortSignal.timeout(12000)
    });
    const data=await response.json().catch(()=>null);
    if(!response.ok) return NextResponse.json({ok:false,mode,providerStatus:response.status,error:"ESCROWLY_AUTH_OR_API_ERROR",message:typeof data?.message==="string"?data.message:"Escrowly rejected the API request."},{status:502});
    return NextResponse.json({ok:true,provider:"Escrowly Connect",mode,authentication:"valid",webhookConfigured:Boolean(process.env.ESCROWLY_WEBHOOK_SECRET),readOnly:true,transactionsFound:Number(data?.total??data?.data?.length??0)},{headers:{"Cache-Control":"no-store"}});
  }catch(error){
    return NextResponse.json({ok:false,mode,error:error instanceof Error?error.message:"ESCROWLY_UNREACHABLE"},{status:502});
  }
}
