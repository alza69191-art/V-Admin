import {NextRequest,NextResponse} from "next/server";
import {jwtVerify} from "jose";
import {createCipheriv,createHash,randomBytes} from "node:crypto";
import {initDb,pool} from "@/lib/db";
export const dynamic="force-dynamic";
const callbackUrl="https://v-admin-api.onrender.com/api/dropbox/oauth/callback";
function secret(){const value=process.env.SESSION_SECRET;if(!value||value.length<32)throw new Error("SESSION_SECRET is not configured");return new TextEncoder().encode(value);}
function encrypt(value:string){const key=createHash("sha256").update(process.env.SESSION_SECRET!).digest();const iv=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",key,iv);const encrypted=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);return {iv:iv.toString("base64url"),tag:cipher.getAuthTag().toString("base64url"),data:encrypted.toString("base64url")};}
function fail(reason:string){return NextResponse.redirect(new URL("/?dropbox="+encodeURIComponent(reason),callbackUrl));}
export async function GET(req:NextRequest){
 try{
  const appKey=process.env.DROPBOX_APP_KEY,appSecret=process.env.DROPBOX_APP_SECRET;if(!appKey||!appSecret)return fail("credentials_missing");
  const code=req.nextUrl.searchParams.get("code"),state=req.nextUrl.searchParams.get("state"),signed=req.cookies.get("v_dropbox_oauth_state")?.value;if(!code||!state||!signed)return fail("state_missing");
  const {payload}=await jwtVerify(signed,secret());if(payload.state!==state)return fail("state_invalid");
  const body=new URLSearchParams({code,grant_type:"authorization_code",redirect_uri:callbackUrl});
  const response=await fetch("https://api.dropboxapi.com/oauth2/token",{method:"POST",headers:{"Authorization":"Basic "+Buffer.from(appKey+":"+appSecret).toString("base64"),"Content-Type":"application/x-www-form-urlencoded"},body,cache:"no-store"});
  if(!response.ok)return fail("token_exchange_failed");
  const token=await response.json() as {refresh_token?:string;account_id?:string};if(!token.refresh_token)return fail("refresh_token_missing");
  await initDb();const stored=JSON.stringify({version:1,...encrypt(token.refresh_token),accountId:token.account_id||null,connectedAt:new Date().toISOString()});
  await pool.query("INSERT INTO v_settings(`key`,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()",["dropbox_oauth",stored]);
  const result=NextResponse.redirect(new URL("/?dropbox=connected",callbackUrl));result.cookies.delete("v_dropbox_oauth_state");return result;
 }catch{return fail("oauth_error");}
}