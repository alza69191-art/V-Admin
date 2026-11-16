import {createDecipheriv,createHash} from "node:crypto";
import {initDb,pool} from "@/lib/db";
type Stored={version:number;iv:string;tag:string;data:string;accountId?:string|null};
async function accessToken(){
 const key=process.env.DROPBOX_APP_KEY,secret=process.env.DROPBOX_APP_SECRET;
 if(!key||!secret)throw new Error("DROPBOX_APP_CREDENTIALS_MISSING");
 await initDb();
 const r=await pool.query<{value:any}>("SELECT value FROM v_settings WHERE `key`=$1",["dropbox_oauth"]);
 if(!r.rows.length)throw new Error("DROPBOX_NOT_AUTHORIZED");
 let stored:any=r.rows[0].value;if(typeof stored==="string")stored=JSON.parse(stored);
 const s=stored as Stored;if(s.version!==1||!s.iv||!s.tag||!s.data)throw new Error("DROPBOX_TOKEN_INVALID");
 const encryptionKey=createHash("sha256").update(process.env.SESSION_SECRET!).digest();
 const decipher=createDecipheriv("aes-256-gcm",encryptionKey,Buffer.from(s.iv,"base64url"));
 decipher.setAuthTag(Buffer.from(s.tag,"base64url"));
 const refreshToken=Buffer.concat([decipher.update(Buffer.from(s.data,"base64url")),decipher.final()]).toString("utf8");
 const response=await fetch("https://api.dropbox.com/oauth2/token",{method:"POST",headers:{"Authorization":"Basic "+Buffer.from(key+":"+secret).toString("base64"),"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:refreshToken}),cache:"no-store"});
 if(!response.ok)throw new Error("DROPBOX_TOKEN_REFRESH_FAILED");
 const token=await response.json() as {access_token:string};return token.access_token;
}
export async function uploadDropboxFile(id:string,name:string,mime:string,bytes:Buffer){
 const token=await accessToken();const safeName=name.replace(/[^\p{L}\p{N}._-]+/gu,"_").slice(0,120)||"image";
 const path="/"+id+"_"+safeName;
 const response=await fetch("https://content.dropboxapi.com/2/files/upload",{method:"POST",headers:{"Authorization":"Bearer "+token,"Content-Type":"application/octet-stream","Dropbox-API-Arg":JSON.stringify({path,mode:"add",autorename:false,mute:true,strict_conflict:true})},body:new Uint8Array(bytes),cache:"no-store"});
 if(!response.ok)throw new Error("DROPBOX_UPLOAD_FAILED");
 await initDb();await pool.query("INSERT INTO v_dropbox_assets(id,dropbox_path,mime_type,file_name,size_bytes) VALUES($1,$2,$3,$4,$5)",[id,path,mime,name.slice(0,180),bytes.length]);
 return {id,url:"https://v-admin-api.onrender.com/api/public/assets/"+id};
}
export async function downloadDropboxFile(path:string){
 const token=await accessToken();const response=await fetch("https://content.dropboxapi.com/2/files/download",{method:"POST",headers:{"Authorization":"Bearer "+token,"Dropbox-API-Arg":JSON.stringify({path})},cache:"no-store"});
 if(!response.ok)throw new Error("DROPBOX_DOWNLOAD_FAILED");return response;
}