import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { pool } from "@/lib/db";

let schemaReady: Promise<void> | null = null;
async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query("CREATE TABLE IF NOT EXISTS v_rate_limits (bucket_key CHAR(64) NOT NULL PRIMARY KEY,window_started_at DATETIME NOT NULL,request_count INT NOT NULL DEFAULT 0,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,INDEX idx_rate_limit_updated(updated_at))").then(() => undefined).catch(error => { schemaReady = null; throw error; });
  }
  return schemaReady;
}

export async function enforceRateLimit(req: NextRequest, route: string, limit: number, windowSeconds: number, identity = "") {
  if (process.env.NODE_ENV !== "production") return { allowed: true, remaining: limit, retryAfter: 0 };
  await ensureSchema();
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || req.headers.get("x-real-ip") || "unknown";
  const key = createHash("sha256").update(route + "|" + ip + "|" + identity.toLowerCase()).digest("hex");
  const window = Math.max(1, Math.min(86400, Math.floor(windowSeconds)));
  const max = Math.max(1, Math.min(1000, Math.floor(limit)));
  await pool.query(
    "INSERT INTO v_rate_limits(bucket_key,window_started_at,request_count) VALUES($1,NOW(),1) ON DUPLICATE KEY UPDATE request_count=IF(window_started_at<DATE_SUB(NOW(),INTERVAL " + window + " SECOND),1,request_count+1),window_started_at=IF(window_started_at<DATE_SUB(NOW(),INTERVAL " + window + " SECOND),NOW(),window_started_at)",
    [key]
  );
  const result = await pool.query<any>("SELECT request_count,TIMESTAMPDIFF(SECOND,window_started_at,NOW()) AS elapsed FROM v_rate_limits WHERE bucket_key=$1 LIMIT 1", [key]);
  const count = Number(result.rows[0]?.request_count || 0);
  const elapsed = Number(result.rows[0]?.elapsed || 0);
  const retryAfter = Math.max(1, window - elapsed);
  return { allowed: count <= max, remaining: Math.max(0, max - count), retryAfter };
}
