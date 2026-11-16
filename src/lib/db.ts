import { Pool } from "pg";
const globalForPg = globalThis as unknown as { pool?: Pool };
export const pool = globalForPg.pool ?? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes("render.com") ? { rejectUnauthorized:false } : undefined, max: 5 });
if (process.env.NODE_ENV !== "production") globalForPg.pool = pool;
export async function initDb(){
 await pool.query(`CREATE TABLE IF NOT EXISTS v_settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz DEFAULT now());
 CREATE TABLE IF NOT EXISTS v_products (id bigserial PRIMARY KEY, title text NOT NULL, description text DEFAULT '', price numeric(12,2) NOT NULL DEFAULT 0, currency text NOT NULL DEFAULT 'USD', image_url text DEFAULT '', category text DEFAULT 'عام', stock integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'published', created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
 CREATE TABLE IF NOT EXISTS v_submissions (id bigserial PRIMARY KEY, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', created_at timestamptz DEFAULT now());
 CREATE TABLE IF NOT EXISTS v_audit (id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, entity text, entity_id text, created_at timestamptz DEFAULT now());`);
 const defaults:any={storeName:"V Store",logoText:"V",primary:"#5424d8",secondary:"#1767e8",background:"#f7f8fc",surface:"#ffffff",text:"#15182b",announcement:"اكتشف تشكيلتنا الجديدة",allowCustomerSubmissions:false,currency:"USD",language:"ar",maintenance:false,heroTitle:"اكتشف ما يناسبك",heroSubtitle:"تسوّق تجربة مختلفة",heroImage:"",supportEmail:"support@example.com",whatsapp:"",instagram:"",footerText:"© V Store"};
 for(const [key,value] of Object.entries(defaults)) await pool.query("INSERT INTO v_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING",[key,JSON.stringify(value)]);
 const count=await pool.query("SELECT count(*)::int n FROM v_products");
 if(!count.rows[0].n) await pool.query("INSERT INTO v_products(title,description,price,currency,image_url,category,stock) VALUES ($1,$2,$3,$4,$5,$6,$7),($8,$9,$10,$11,$12,$13,$14),($15,$16,$17,$18,$19,$20,$21)",["سماعات لاسلكية","صوت نقي وتصميم أنيق",59.9,"USD","", "إلكترونيات",24,"ساعة عصرية","أناقة لكل يوم",89,"USD","","إكسسوارات",12,"حقيبة يومية","تصميم عملي وخامات ممتازة",42,"USD","","أزياء",18]);
}
