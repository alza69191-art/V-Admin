export type VaultionSession = { merchantId?: string; sessionId: string; checkoutPath: string };
const API = "https://checkout.vaultion.org";

export async function createVaultionCheckout(payload: Record<string, unknown>): Promise<VaultionSession> {
  const response = await fetch(API + "/v1/stores/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof data?.error === "string" ? data.error : "vaultion_request_failed";
    throw new Error(code);
  }
  if (typeof data?.sessionId !== "string" || !/^[a-f0-9]{64}$/.test(data.sessionId) ||
      typeof data?.checkoutPath !== "string" || !/^\/c\/[a-f0-9]{64}$/.test(data.checkoutPath)) {
    throw new Error("vaultion_invalid_response");
  }
  return data as VaultionSession;
}

export async function readVaultionSession(sessionId: string): Promise<any> {
  if (!/^[a-f0-9]{64}$/.test(sessionId)) throw new Error("invalid_session_id");
  const response = await fetch(API + "/v1/stores/sessions/" + sessionId, {
    method: "GET",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "vaultion_status_failed");
  return data;
}
