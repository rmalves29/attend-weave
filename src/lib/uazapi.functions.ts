import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Colunas seguras para leitura por qualquer autenticado (sem credentials)
const CHANNEL_PUBLIC_COLS =
  "id, name, type, identifier, status, qr_code, last_connected_at, created_at, updated_at";

// ---------- helpers ----------
function getUazapiConfig() {
  const url = process.env.UAZAPI_URL?.replace(/\/$/, "");
  const adminToken = process.env.UAZAPI_ADMIN_TOKEN;
  if (!url || !adminToken) {
    throw new Error(
      "uazapi não configurada. Adicione os secrets UAZAPI_URL e UAZAPI_ADMIN_TOKEN.",
    );
  }
  return { url, adminToken };
}

async function uazapiFetch(
  path: string,
  opts: { token?: string; admin?: boolean; method?: string; body?: unknown } = {},
) {
  const { url, adminToken } = getUazapiConfig();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.admin) headers["admintoken"] = adminToken;
  if (opts.token) headers["token"] = opts.token;

  const res = await fetch(`${url}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) {
    const msg = typeof data === "string" ? data : data?.error ?? data?.message ?? `HTTP ${res.status}`;
    throw new Error(`uazapi: ${msg}`);
  }
  return data;
}

async function assertAdmin(ctx: { supabase: any; userId: string }) {
  const { data, error } = await ctx.supabase.rpc("has_role", {
    _user_id: ctx.userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Apenas administradores podem gerenciar canais.");
}

async function loadChannelWithCreds(channelId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("channels").select("*").eq("id", channelId).single();
  if (error || !data) throw new Error("Canal não encontrado");
  return { channel: data, supabaseAdmin };
}

function webhookUrlFor(channelId: string) {
  const base =
    process.env.PUBLIC_APP_URL?.replace(/\/$/, "") ??
    "https://attend-weave.lovable.app";
  return `${base}/api/public/uazapi-webhook/${channelId}`;
}

// ---------- create ----------
export const createUazapiInstance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ name: z.string().min(1).max(60) }))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // 1. cria instância na uazapi (admintoken)
    const created = await uazapiFetch("/instance/init", {
      admin: true,
      body: { name: data.name, systemName: "AttendFlow" },
    });
    const instanceToken: string =
      created?.token ?? created?.instance?.token ?? created?.data?.token;
    const instanceId: string =
      created?.id ?? created?.instance?.id ?? created?.data?.id ?? data.name;
    if (!instanceToken) throw new Error("Token da instância não retornado pela uazapi.");

    // 2. salva no banco (admin — credentials é coluna privilegiada)
    const { data: channel, error } = await supabaseAdmin
      .from("channels")
      .insert({
        name: data.name,
        type: "whatsapp",
        status: "disconnected",
        identifier: instanceId,
        credentials: { provider: "uazapi", token: instanceToken, instance_id: instanceId },
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    // 3. configura webhook (best-effort — não bloqueia se falhar)
    try {
      await uazapiFetch("/webhook", {
        token: instanceToken,
        body: {
          url: webhookUrlFor(channel.id),
          enabled: true,
          events: ["messages", "messages_update", "connection", "qrcode"],
          excludeMessages: [],
          addUrlEvents: false,
        },
      });
    } catch (e) {
      console.warn("[uazapi] webhook setup falhou:", (e as Error).message);
    }

    return { channelId: channel.id };
  });

// ---------- connect / QR ----------
export const connectUazapiInstance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ channelId: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { channel, supabaseAdmin } = await loadChannelWithCreds(data.channelId);
    const token = (channel.credentials as any)?.token;
    if (!token) throw new Error("Instância sem token uazapi");

    const res = await uazapiFetch("/instance/connect", { token, body: {} });
    const qr: string | undefined = res?.instance?.qrcode ?? res?.qrcode ?? res?.qr;
    const status = res?.instance?.status ?? res?.status ?? "connecting";

    await supabaseAdmin
      .from("channels")
      .update({ qr_code: qr ?? null, status: status === "connected" ? "connected" : "connecting" })
      .eq("id", data.channelId);

    return { qr, status };
  });

// ---------- status polling ----------
export const getUazapiStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ channelId: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { channel, supabaseAdmin } = await loadChannelWithCreds(data.channelId);
    const token = (channel.credentials as any)?.token;
    if (!token) throw new Error("Instância sem token uazapi");

    const res = await uazapiFetch("/instance/status", { token });
    const raw = res?.instance?.status ?? res?.status ?? "disconnected";
    const mapped =
      raw === "connected" ? "connected"
      : raw === "connecting" ? "connecting"
      : raw === "disconnected" ? "disconnected"
      : "error";

    const patch: any = { status: mapped };
    if (mapped === "connected") {
      patch.qr_code = null;
      patch.last_connected_at = new Date().toISOString();
      patch.identifier = res?.instance?.wid ?? res?.instance?.owner ?? channel.identifier;
    }
    await supabaseAdmin.from("channels").update(patch).eq("id", data.channelId);
    return { status: mapped };
  });

// ---------- disconnect ----------
export const disconnectUazapiInstance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ channelId: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { channel, supabaseAdmin } = await loadChannelWithCreds(data.channelId);
    const token = (channel.credentials as any)?.token;
    if (token) {
      try { await uazapiFetch("/instance/disconnect", { token, body: {} }); } catch {}
    }
    await supabaseAdmin.from("channels")
      .update({ status: "disconnected", qr_code: null }).eq("id", data.channelId);
    return { ok: true };
  });

// ---------- delete ----------
export const deleteUazapiInstance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ channelId: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { channel, supabaseAdmin } = await loadChannelWithCreds(data.channelId);
    const creds = (channel.credentials as any) ?? {};
    const token: string | undefined = creds.token;
    const instanceId: string | undefined = creds.instance_id;

    if (token) {
      try { await uazapiFetch("/instance/disconnect", { token, body: {} }); } catch {}
    }
    if (instanceId) {
      try {
        await uazapiFetch(`/instance/${encodeURIComponent(instanceId)}`, {
          admin: true, method: "DELETE",
        });
      } catch (e) {
        console.warn("[uazapi] delete remoto falhou:", (e as Error).message);
      }
    }
    const { error } = await supabaseAdmin.from("channels").delete().eq("id", data.channelId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ---------- send message ----------
// Envia via uazapi E persiste a mensagem no banco (assim aparece na UI
// mesmo se o webhook fromMe não devolver). Deduplicação por external_id
// evita duplicata quando o webhook eventualmente também chegar.
export const sendUazapiMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    conversationId: z.string().uuid(),
    text: z.string().min(1),
  }))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: conv, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id, channel_id, contact_id, assigned_agent_id, unread_count, contacts(phone), channels(credentials)")
      .eq("id", data.conversationId).single();
    if (convErr || !conv) throw new Error("Conversa não encontrada");

    const phone = (conv as any).contacts?.phone as string | null;
    if (!phone) throw new Error("Contato sem telefone");
    const token = ((conv as any).channels?.credentials as any)?.token;
    if (!token) throw new Error("Canal sem token uazapi");

    const res = await uazapiFetch("/send/text", {
      token,
      body: { number: phone, text: data.text },
    });
    const externalId: string | null =
      res?.messageid ?? res?.id ?? res?.key?.id ?? res?.message?.key?.id ?? null;

    const { error: insErr } = await supabaseAdmin.from("messages").insert({
      conversation_id: conv.id,
      sender_agent_id: context.userId,
      direction: "outbound",
      type: "text",
      content: data.text,
      status: "sent",
      external_id: externalId,
      metadata: { uazapi: res },
    });
    if (insErr && (insErr as any).code !== "23505") throw insErr;

    await supabaseAdmin.from("conversations").update({
      assigned_agent_id: conv.assigned_agent_id ?? context.userId,
      last_message_at: new Date().toISOString(),
      last_message_preview: data.text.slice(0, 120),
    }).eq("id", conv.id);

    return { ok: true, id: externalId };
  });

// ---------- sync history ----------
// Puxa mensagens recentes de um canal (ou de todos) via uazapi e ingere.
export const syncUazapiHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    channelId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { ingestMessage } = await import("./uazapi-ingest.server");

    const q = supabaseAdmin.from("channels").select("*").eq("type", "whatsapp");
    if (data.channelId) q.eq("id", data.channelId);
    const { data: channels, error } = await q;
    if (error) throw new Error(error.message);

    const limit = data.limit ?? 100;
    let ingested = 0;
    let errors = 0;

    for (const ch of channels ?? []) {
      const token = (ch.credentials as any)?.token;
      if (!token) continue;
      let msgs: any[] = [];
      try {
        // uazapi: POST /message/find (ordena por timestamp desc)
        const res = await uazapiFetch("/message/find", {
          token,
          body: { sort: "-messageTimestamp", limit },
        });
        msgs = Array.isArray(res) ? res : res?.messages ?? res?.data ?? [];
      } catch (e) {
        console.warn("[uazapi sync] find falhou:", (e as Error).message);
        errors++;
        continue;
      }
      // ingere do mais antigo para o mais novo (preserva ordem)
      for (const m of [...msgs].reverse()) {
        try { await ingestMessage(supabaseAdmin, ch.id, m); ingested++; }
        catch (e) { errors++; console.error("[uazapi sync] ingest err:", (e as Error).message); }
      }
    }

    return { ingested, errors, channels: channels?.length ?? 0 };
  });

// re-export para conveniência de consumidores que queiram tipar
export { CHANNEL_PUBLIC_COLS };
