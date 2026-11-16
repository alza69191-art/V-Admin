import {NextRequest,NextResponse} from "next/server";
import {randomUUID} from "node:crypto";
import {isAdmin} from "@/lib/auth";
import {uploadDropboxFile} from "@/lib/dropbox";
export const runtime="nodejs";
export async function POST(req:NextRequest){
 if(!await isAdmin())return NextResponse.json({error:"unauthorized"},{status:401});
 const form=await req.formData();const file=form.get("file");
 if(!(file instanceof File))return NextResponse.json({error:"file_required"},{status:400});
 const allowed=["image/jpeg","image/png","image/webp","image/gif"];
 if(!allowed.includes(file.type)||file.size>4*1024*1024)return NextResponse.json({error:"يسمح بصور JPG وPNG وWebP وGIF حتى 4MB"},{status:400});
 try{const id=randomUUID();const result=await uploadDropboxFile(id,file.name,file.type,Buffer.from(await file.arrayBuffer()));return NextResponse.json(result,{status:201});}
 catch(error){const reason=error instanceof Error?error.message:"UPLOAD_FAILED";const status=reason==="DROPBOX_NOT_AUTHORIZED"||reason==="DROPBOX_APP_CREDENTIALS_MISSING"?503:502;return NextResponse.json({error:reason},{status});}
}