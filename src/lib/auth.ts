import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
const secret=()=>{const value=process.env.SESSION_SECRET;if(!value||value.length<32)throw new Error("SESSION_SECRET must be configured with at least 32 characters");return new TextEncoder().encode(value);};
export async function issueSession(){return new SignJWT({role:"admin"}).setProtectedHeader({alg:"HS256"}).setIssuedAt().setExpirationTime("8h").sign(secret());}
export async function isAdmin(){try{const c=await cookies();const token=c.get("v_admin_session")?.value;if(!token)return false;const {payload}=await jwtVerify(token,secret());return payload.role==="admin";}catch{return false;}}
