/**
 * Evolution API (WhatsApp) integration service.
 * Structure-only stub — replace placeholder calls with real HTTP requests
 * pointing to your Evolution API instance.
 */

const EVOLUTION_BASE_URL = import.meta.env.VITE_EVOLUTION_API_URL ?? "";
const EVOLUTION_API_KEY = import.meta.env.VITE_EVOLUTION_API_KEY ?? "";

async function evolutionFetch(path: string, init: RequestInit = {}) {
  if (!EVOLUTION_BASE_URL) {
    throw new Error("Evolution API URL not configured");
  }
  const res = await fetch(`${EVOLUTION_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_API_KEY,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Evolution API error: ${res.status}`);
  return res.json();
}

export const evolutionApi = {
  async sendMessage(instance: string, to: string, message: string) {
    return evolutionFetch(`/message/sendText/${instance}`, {
      method: "POST",
      body: JSON.stringify({ number: to, text: message }),
    });
  },
  async getQRCode(instance: string) {
    return evolutionFetch(`/instance/connect/${instance}`);
  },
  async getInstances() {
    return evolutionFetch(`/instance/fetchInstances`);
  },
  async disconnectInstance(instance: string) {
    return evolutionFetch(`/instance/logout/${instance}`, { method: "DELETE" });
  },
};
