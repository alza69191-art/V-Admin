import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { pool } from "@/lib/db";

const API = "https://api.escrowly.com/api/v1";
let schemaReady: Promise<void> | null = null;

export async function ensureEscrowlySchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query("ALTER TABLE v_order_escrows ADD COLUMN IF NOT EXISTS transaction_id VARCHAR(100) NULL");
      await pool.query("ALTER TABLE v_order_escrows ADD COLUMN IF NOT EXISTS currency VARCHAR(8) NULL");
      await pool.query("ALTER TABLE v_order_escrows ADD COLUMN IF NOT EXISTS amount DECIMAL(20,8) NULL");
      await pool.query("ALTER TABLE v_order_escrows ADD COLUMN IF NOT EXISTS mode VARCHAR(8) NULL");
      await pool.query("CREATE TABLE IF NOT EXISTS v_escrowly_webhook_events (event_id VARCHAR(120) NOT NULL PRIMARY KEY, transaction_id VARCHAR(100) NOT NULL, event_type VARCHAR(80) NOT NULL, mode VARCHAR(8) NOT NULL, received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_escrowly_event_tx(transaction_id))");
      await pool.query("ALTER TABLE v_freelance_orders ADD COLUMN IF NOT EXISTS bid_id BIGINT UNSIGNED NULL");
      await pool.query("ALTER TABLE v_freelance_orders ADD COLUMN IF NOT EXISTS escrow_checkout_url VARCHAR(512) NULL");
      await pool.query("ALTER TABLE v_freelance_orders ADD COLUMN IF NOT EXISTS escrow_mode VARCHAR(8) NULL");
      await pool.query("ALTER TABLE v_freelance_orders ADD COLUMN IF NOT EXISTS delivered_at DATETIME NULL");
      await pool.query("ALTER TABLE v_freelance_orders ADD COLUMN IF NOT EXISTS disputed_at DATETIME NULL");
      await pool.query("ALTER TABLE v_freelance_orders ADD COLUMN IF NOT EXISTS admin_note TEXT NULL");
      await pool.query("ALTER TABLE v_freelance_orders ADD COLUMN IF NOT EXISTS admin_reviewed_at DATETIME NULL");
      await pool.query("CREATE TABLE IF NOT EXISTS v_freelance_order_events (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,order_id BIGINT UNSIGNED NOT NULL,actor VARCHAR(100) NOT NULL,from_status VARCHAR(32) NULL,to_status VARCHAR(32) NOT NULL,note VARCHAR(500) NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX idx_freelance_order_events_order(order_id))");
    })().catch((error) => { schemaReady = null; throw error; });
  }
  return schemaReady;
}

export function escrowlyMode() {
  const key = process.env.ESCROWLY_API_KEY || "";
  if (key.startsWith("ek_test_")) return "test";
  if (key.startsWith("ek_live_")) return "live";
  return null;
}

export function assertEscrowlyReady() {
  const key = process.env.ESCROWLY_API_KEY || "";
  const mode = escrowlyMode();
  if (!mode) throw new Error("ESCROWLY_API_KEY_NOT_CONFIGURED");
  if (mode === "live" && process.env.ESCROWLY_LIVE_ENABLED !== "true") {
    throw new Error("ESCROWLY_LIVE_MODE_DISABLED");
  }
  return { key, mode };
}

async function request(path: string, init: RequestInit = {}) {
  const { key } = assertEscrowlyReady();
  const response = await fetch(API + path, {
    ...init,
    headers: { "X-Api-Key": key, "Content-Type": "application/json", ...(init.headers || {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = typeof data?.error === "string" ? data.error : typeof data?.message === "string" ? data.message : "ESCROWLY_REQUEST_FAILED";
    throw new Error("ESCROWLY_" + response.status + "_" + error.slice(0, 100));
  }
  return data;
}

export async function createEscrowlyTransaction(payload: Record<string, unknown>) {
  const data = await request("/connect/transactions", { method: "POST", body: JSON.stringify(payload) });
  if (typeof data?.id !== "string" || typeof data?.checkout_url !== "string") throw new Error("ESCROWLY_INVALID_CREATE_RESPONSE");
  const checkout = new URL(data.checkout_url);
  if (checkout.protocol !== "https:" || checkout.hostname !== "my.escrowly.com") throw new Error("ESCROWLY_INVALID_CHECKOUT_URL");
  return data;
}

export async function readEscrowlyTransaction(transactionId: string) {
  if (!/^[a-zA-Z0-9_-]{8,120}$/.test(transactionId)) throw new Error("ESCROWLY_INVALID_TRANSACTION_ID");
  return request("/connect/transactions/" + encodeURIComponent(transactionId), { method: "GET" });
}

export async function markEscrowlyDelivered(transactionId: string) {
  if (!/^[a-zA-Z0-9_-]{8,120}$/.test(transactionId)) throw new Error("ESCROWLY_INVALID_TRANSACTION_ID");
  return request("/connect/transactions/" + encodeURIComponent(transactionId) + "/mark-delivered", { method: "POST" });
}

export function verifyEscrowlySignature(rawBody: string, signature: string, secret: string) {
  if (!/^[a-f0-9]{64}$/i.test(signature) || !secret) return false;
  const signingKey = createHash("sha256").update(secret).digest("hex");
  const expected = createHmac("sha256", signingKey).update(rawBody).digest();
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function validEscrowlyStatus(status: unknown): status is string {
  return typeof status === "string" && [
    "awaiting_payment", "payment_detected", "funded", "inspection_expiring",
    "completed", "disputed", "resolved", "refunded", "cancelled", "expired",
  ].includes(status);
}

export function sameMoney(a: unknown, b: unknown) {
  const x = Number(a), y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 0.00000001;
}
