import {NextResponse} from "next/server";
import {pool,initDb} from "@/lib/db";
import {downloadDropboxFile} from "@/lib/dropbox";
export const runtime="nodejs";
export async function GET(_req:Request,{params}:{params:Promise<{id:string}>}){
 try{await initDb();const {id}=await params;
  if(!/^[a-zA-Z0-9-]{1,80}$/.test(id))return new NextResponse(null,{status:404});
  const modern=await pool.query<{dropbox_path:string;mime_type:string}>("SELECT dropbox_path,mime_type FROM v_dropbox_assets WHERE id=$1",[id]);
  if(modern.rows.length){const file=await downloadDropboxFile(modern.rows[0].dropbox_path);return new NextResponse(file.body,{headers:{"Content-Type":modern.rows[0].mime_type,"Cache-Control":"public, max-age=3600, s-maxage=86400","X-Content-Type-Options":"nosniff"}});}
  if(/^\d+$/.test(id)){const old=await pool.query<{mime_type:string;data:Buffer}>("SELECT mime_type,data FROM v_assets WHERE id=$1",[id]);if(old.rows.length)return new NextResponse(old.rows[0].data as any,{headers:{"Content-Type":old.rows[0].mime_type,"Cache-Control":"public, max-age=86400","X-Content-Type-Options":"nosniff"}});}
  return new NextResponse(null,{status:404});
 }catch{return new NextResponse(null,{status:503});}
}