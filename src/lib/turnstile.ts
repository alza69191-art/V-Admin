export async function verifyTurnstile(token:string,remoteIp?:string|null):Promise<boolean>{
 const secret=process.env.TURNSTILE_SECRET_KEY;
 if(!secret)return process.env.NODE_ENV!=="production";
 if(!token||token.length>2048)return false;
 try{
  const body=new URLSearchParams({secret,response:token});
  if(remoteIp)body.set("remoteip",remoteIp);
  const response=await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body,cache:"no-store",signal:AbortSignal.timeout(8000)});
  if(!response.ok)return false;
  const result=await response.json();
  return result.success===true;
 }catch{return false;}
}