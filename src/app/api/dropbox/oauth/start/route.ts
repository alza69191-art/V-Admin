import {NextRequest,NextResponse} from "next/server";
import {SignJWT} from "jose";
import {randomUUID} from "node:crypto";
export const dynamic="force-dynamic";
const callbackUrl="https://v-admin-api.onrender.com/api/dropbox/oauth/callback";
function secret(){const value=process.env.SESSION_SECRET;if(!value||value.length<32)throw new Error("SESSION_SECRET is not configured");return new TextEncoder().encode(value);}
export async function GET(req:NextRequest){
  const appKey=process.env.DROPBOX_APP_KEY;
  if(!appKey)return NextResponse.json({error:"dropbox_app_key_not_configured"},{status:503});
  const state=randomUUID();
  const signed=await new SignJWT({state}).setProtectedHeader({alg:"HS256"}).setIssuedAt().setExpirationTime("10m").sign(secret());
  const url=new URL("https://www.dropbox.com/oauth2/authorize");
  url.searchParams.set("client_id",appKey);url.searchParams.set("response_type","code");url.searchParams.set("token_access_type","offline");url.searchParams.set("redirect_uri",callbackUrl);url.searchParams.set("state",state);
  const response=NextResponse.redirect(url);
  response.cookies.set("v_dropbox_oauth_state",signed,{httpOnly:true,secure:true,sameSite:"lax",path:"/api/dropbox/oauth",maxAge:600});
  return response;
}