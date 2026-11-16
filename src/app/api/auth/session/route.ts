import {NextResponse} from "next/server";
import {cookies} from "next/headers";
import {isAdmin} from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(){
  const jar = await cookies();
  const token = jar.get("v_admin_session")?.value;
  const secret = process.env.SESSION_SECRET;
  return NextResponse.json(
    {
      authenticated: await isAdmin(),
      sessionCookiePresent: Boolean(token),
      sessionSecretConfigured: Boolean(secret),
      sessionSecretLengthValid: Boolean(secret && secret.length >= 32)
    },
    {headers:{"Cache-Control":"no-store"}}
  );
}
