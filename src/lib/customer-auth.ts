import {cookies} from "next/headers";import {jwtVerify,SignJWT} from "jose";
const key=()=>{const s=process.env.SESSION_SECRET;if(!s||s.length<32)throw new Error("SESSION_SECRET missing");return new TextEncoder().encode(s);};
export async function issueCustomerSession(id:number){return new SignJWT({role:"customer",customerId:id}).setProtectedHeader({alg:"HS256"}).setIssuedAt().setExpirationTime("30d").sign(key());}
export async function currentCustomer(){try{const c=await cookies();const token=c.get("v_customer_session")?.value;if(!token)return null;const {payload}=await jwtVerify(token,key());if(payload.role!=="customer"||typeof payload.customerId!=="number")return null;return {id:payload.customerId};}catch{return null;}}
