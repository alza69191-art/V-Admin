import { NextResponse } from "next/server"; import { pool } from "@/lib/db";
export const dynamic="force-dynamic";
export async function GET(){try{const r=await pool.query("SELECT key,value FROM v_settings");return NextResponse.json(Object.fromEntries(r.rows.map(x=>[x.key,x.value])) ,{headers:{"Cache-Control":"no-store"}});}catch{return NextResponse.json({error:"database_unavailable"},{status:503});}}
