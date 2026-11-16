import mysql, { Pool as MySqlPool } from "mysql2/promise";
for (const key of ["DB_HOST","DB_USER","DB_PASSWORD","DB_NAME"]) if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
const g = globalThis as unknown as { mysqlPool?: MySqlPool };
const mysqlPool = g.mysqlPool ?? mysql.createPool({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||4000),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,ssl:process.env.DB_SSL==="true"?{minVersion:"TLSv1.2"}:undefined,waitForConnections:true,connectionLimit:5,queueLimit:0,connectTimeout:20000});
if(process.env.NODE_ENV!=="production") g.mysqlPool=mysqlPool;
type Result<T>={rows:T[];rowCount:number;insertId?:number};
export const pool={async query<T=any>(input:string,values:any[]=[]):Promise<Result<T>>{
 let sql=input.trim();const ordered:any[]=[];
 sql=sql.replace(/\$(\d+)/g,(_m,n)=>{ordered.push(values[Number(n)-1]);return "?"});
 if(/ON CONFLICT\s*\(\s*key\s*\)\s*DO UPDATE/i.test(sql)) sql=sql.replace(/ON CONFLICT\s*\(\s*key\s*\)\s*DO UPDATE SET value\s*=\s*EXCLUDED\.value\s*,\s*updated_at\s*=\s*now\(\)/i,"ON DUPLICATE KEY UPDATE value=VALUES(value), updated_at=NOW()");
 else if(/ON CONFLICT\s*\(\s*key\s*\)\s*DO NOTHING/i.test(sql)) sql=sql.replace(/^INSERT\s+INTO/i,"INSERT IGNORE INTO").replace(/ON CONFLICT\s*\(\s*key\s*\)\s*DO NOTHING/i,"");
 sql=sql.replace(/count\(\*\)::int\s+n/i,"COUNT(*) AS n").replace(/AS\s+"imageUrl"/g,"AS imageUrl");
 const returning=/\s+RETURNING\s+\*\s*;?$/i.test(sql);sql=sql.replace(/\s+RETURNING\s+\*\s*;?$/i,"");
 const ins=/^INSERT\s+INTO\s+(\w+)/i.exec(sql),upd=/^UPDATE\s+(\w+)/i.exec(sql);
 const [res]=await mysqlPool.execute(sql,ordered.length?ordered:values);
 if(returning&&ins){const id=(res as mysql.ResultSetHeader).insertId;const [rows]=await mysqlPool.execute(`SELECT * FROM ${ins[1]} WHERE id=? LIMIT 1`,[id]);return {rows:rows as T[],rowCount:(res as mysql.ResultSetHeader).affectedRows||0};}
 if(returning&&upd){const [rows]=await mysqlPool.execute(`SELECT * FROM ${upd[1]} WHERE id=? LIMIT 1`,[values[0]]);return {rows:rows as T[],rowCount:(rows as any[]).length};}
 if(Array.isArray(res))return {rows:res as T[],rowCount:res.length};
 return {rows:[],rowCount:(res as mysql.ResultSetHeader).affectedRows||0,insertId:(res as mysql.ResultSetHeader).insertId};
}};
let initPromise:Promise<void>|null=null;
export async function initDb(){if(initPromise)return initPromise;initPromise=(async()=>{
 await pool.query(`CREATE TABLE IF NOT EXISTS v_settings (\`key\` VARCHAR(191) NOT NULL PRIMARY KEY,value JSON NOT NULL,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS v_products (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,title VARCHAR(180) NOT NULL,description TEXT,price DECIMAL(12,2) NOT NULL DEFAULT 0,currency VARCHAR(8) NOT NULL DEFAULT 'USD',image_url TEXT,category VARCHAR(100) DEFAULT 'عام',stock INT NOT NULL DEFAULT 0,status VARCHAR(20) NOT NULL DEFAULT 'published',created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,INDEX idx_products_created(created_at),INDEX idx_products_status(status))`);
 await pool.query(`CREATE TABLE IF NOT EXISTS v_submissions (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,payload JSON NOT NULL,status VARCHAR(20) NOT NULL DEFAULT 'pending',created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX idx_submissions_created(created_at))`);
 await pool.query(`CREATE TABLE IF NOT EXISTS v_audit (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,actor VARCHAR(100) NOT NULL,action VARCHAR(180) NOT NULL,entity VARCHAR(100),entity_id VARCHAR(100),created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS v_customers (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,name VARCHAR(120) NOT NULL,email VARCHAR(190) NOT NULL UNIQUE,password_hash VARCHAR(255) NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,last_login TIMESTAMP NULL)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS v_support_tickets (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,customer_id BIGINT UNSIGNED NOT NULL,subject VARCHAR(180) NOT NULL,status VARCHAR(20) NOT NULL DEFAULT 'open',created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,INDEX idx_ticket_customer(customer_id),INDEX idx_ticket_status(status))`);
 await pool.query(`CREATE TABLE IF NOT EXISTS v_support_messages (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,ticket_id BIGINT UNSIGNED NOT NULL,sender_type VARCHAR(20) NOT NULL,sender_id BIGINT UNSIGNED NOT NULL,body TEXT NOT NULL,read_at TIMESTAMP NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX idx_messages_ticket(ticket_id),INDEX idx_messages_unread(read_at))`);
 await pool.query(`CREATE TABLE IF NOT EXISTS v_assets (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,mime_type VARCHAR(100) NOT NULL,file_name VARCHAR(180) NOT NULL,data LONGBLOB NOT NULL,size_bytes INT NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
 const d:Record<string,any>={storeName:"V Store",logoText:"V",primary:"#5424d8",secondary:"#1767e8",background:"#f7f8fc",surface:"#ffffff",text:"#15182b",announcement:"",allowCustomerSubmissions:false,currency:"USD",language:"ar",maintenance:false,heroTitle:"",heroSubtitle:"",heroImage:"",supportEmail:"",whatsapp:"",instagram:"",footerText:"",aboutTitle:"",aboutText:"",heroKicker:"",categoriesKicker:"",categoriesTitle:"",productsKicker:"",productsTitle:"",bannerKicker:"",bannerTitle:"",bannerText:"",aboutKicker:"",facebook:""};
 for(const [k,v] of Object.entries(d))await pool.query("INSERT INTO v_settings(\`key\`,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING",[k,JSON.stringify(v)]);
})().catch(e=>{initPromise=null;throw e});return initPromise;}
