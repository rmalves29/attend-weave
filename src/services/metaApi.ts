/**
 * Meta Graph API integration service (Instagram + Facebook Messenger).
 * Structure-only stub — wire up real Graph API calls once tokens are available.
 */

const META_GRAPH_BASE = "https://graph.facebook.com/v20.0";

async function metaFetch(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${META_GRAPH_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Meta API error: ${res.status}`);
  return res.json();
}

export const metaApi = {
  async sendInstagramMessage(igAccountId: string, recipientId: string, text: string, token: string) {
    return metaFetch(`/${igAccountId}/messages`, token, {
      method: "POST",
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
    });
  },
  async sendFacebookMessage(pageId: string, recipientId: string, text: string, token: string) {
    return metaFetch(`/${pageId}/messages`, token, {
      method: "POST",
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
    });
  },
};
