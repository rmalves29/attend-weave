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

export async function uazapiFetch(
  path: string,
  opts: { token?: string; admin?: boolean; method?: string; body?: unknown; timeoutMs?: number } = {},
) {
  const { url, adminToken } = getUazapiConfig();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.admin) headers["admintoken"] = adminToken;
  if (opts.token) headers["token"] = opts.token;

  // Sem timeout, uma chamada pendurada da uazapi congela a server fn inteira
  // (sintoma: "Carregando mídia..." infinito no painel).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, {
      method: opts.method ?? (opts.body ? "POST" : "GET"),
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (e: any) {
    throw new Error(e?.name === "AbortError" ? `uazapi: timeout em ${path}` : `uazapi: ${e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
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
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("id")
    .eq("user_id", ctx.userId)
    .eq("role", "admin")
    .maybeSingle();
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

const UAZAPI_WEBHOOK_EVENTS = [
  "history",
  "messages",
  "messages_update",
  "connection",
  "groups",
  "chats",
];

async function configureUazapiWebhook(channelId: string, token: string) {
  return uazapiFetch("/webhook", {
    token,
    body: {
      url: webhookUrlFor(channelId),
      enabled: true,
      events: UAZAPI_WEBHOOK_EVENTS,
      excludeMessages: [],
      addUrlEvents: false,
      addUrlTypesMessages: false,
    },
  });
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
      await configureUazapiWebhook(channel.id, instanceToken);
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

    // Reaplica a configuração para instâncias antigas que foram criadas sem
    // os eventos `history`, `groups` e `chats`.
    try {
      await configureUazapiWebhook(data.channelId, token);
    } catch (e) {
      console.warn("[uazapi] webhook setup falhou ao conectar:", (e as Error).message);
    }

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

    // Reforço ao webhook: se conectou e a descoberta automática ainda não foi
    // disparada para este número, dispara agora (importa todo o histórico).
    if (mapped === "connected" && !(channel as any).history_discovery) {
      try {
        const { startAutoHistory } = await import("./uazapi-discovery.server");
        await startAutoHistory(supabaseAdmin, data.channelId);
      } catch (e) {
        console.warn("[uazapi] auto-history start falhou:", (e as Error).message);
      }
    }
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
    replyToMessageId: z.string().uuid().optional(),
  }))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { sendTextViaUazapi } = await import("./uazapi-send.server");

    const result = await sendTextViaUazapi(supabaseAdmin, {
      conversationId: data.conversationId,
      text: data.text,
      senderAgentId: context.userId,
      replyToMessageId: data.replyToMessageId,
    });
    return { ok: true, id: result.externalId };
  });

// helper: resolve reply target -> short uazapi id + preview
export async function resolveReply(sb: any, replyToMessageId?: string) {
  if (!replyToMessageId) return null;
  const { data: m } = await sb.from("messages")
    .select("id, external_id, content, type, metadata")
    .eq("id", replyToMessageId).maybeSingle();
  if (!m) return null;
  const shortId = extractShortId(m.external_id, m.metadata);
  return {
    shortId,
    preview: {
      messageId: m.id,
      shortId,
      content: (m.content ?? "").slice(0, 200),
      type: m.type,
    },
  };
}

function extractShortId(externalId: string | null, metadata: any): string | undefined {
  const raw = metadata?.raw ?? {};
  return raw?.messageid ?? raw?.messageId ??
    (externalId?.includes(":") ? externalId.split(":").pop()! : externalId ?? undefined);
}

// ---------- send media ----------
// Recebe um path do bucket "attachments" (privado), gera signed URL e envia
// via uazapi /send/media. Persiste a mensagem outbound com metadata do arquivo.
export const sendUazapiMedia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    conversationId: z.string().uuid(),
    storagePath: z.string().min(1),
    filename: z.string().min(1),
    mimeType: z.string().min(1),
    caption: z.string().optional(),
    replyToMessageId: z.string().uuid().optional(),
  }))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: conv, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id, assigned_agent_id, contacts(phone), channels(credentials)")
      .eq("id", data.conversationId).single();
    if (convErr || !conv) throw new Error("Conversa não encontrada");

    const phone = (conv as any).contacts?.phone as string | null;
    if (!phone) throw new Error("Contato sem telefone");
    const token = ((conv as any).channels?.credentials as any)?.token;
    if (!token) throw new Error("Canal sem token uazapi");

    const { data: signed, error: signErr } = await supabaseAdmin
      .storage.from("attachments")
      .createSignedUrl(data.storagePath, 60 * 60);
    if (signErr || !signed?.signedUrl) throw new Error("Falha ao gerar URL do arquivo");

    const mime = data.mimeType;
    const kind =
      mime.startsWith("image/") ? "image" :
      mime.startsWith("video/") ? "video" :
      mime.startsWith("audio/") ? "audio" :
      "document";

    const reply = await resolveReply(supabaseAdmin, data.replyToMessageId);

    const res = await uazapiFetch("/send/media", {
      token,
      body: {
        number: phone,
        type: kind,
        file: signed.signedUrl,
        docName: kind === "document" ? data.filename : undefined,
        text: data.caption ?? "",
        replyid: reply?.shortId,
      },
    });
    const rawExternalId: string | null =
      res?.messageid ?? res?.id ?? res?.key?.id ?? res?.message?.key?.id ?? null;
    // Normaliza pra bater com o formato do webhook/sync ("<jid>:<HEX>" → "<HEX>")
    const externalId: string | null = rawExternalId
      ? (String(rawExternalId).match(/^\d+:(.+)$/)?.[1] ?? String(rawExternalId))
      : null;

    const contentPreview = data.caption?.trim() || `[${kind}] ${data.filename}`;

    const { error: insErr } = await supabaseAdmin.from("messages").insert({
      conversation_id: conv.id,
      sender_agent_id: context.userId,
      direction: "outbound",
      type: kind,
      content: contentPreview,
      status: "sent",
      external_id: externalId,
      metadata: {
        uazapi: res,
        media: { storagePath: data.storagePath, filename: data.filename, mimeType: mime },
        ...(reply ? { replyTo: reply.preview } : {}),
      },
    });
    if (insErr && (insErr as any).code !== "23505") throw insErr;

    await supabaseAdmin.from("conversations").update({
      assigned_agent_id: conv.assigned_agent_id ?? context.userId,
      last_message_at: new Date().toISOString(),
      last_message_preview: contentPreview.slice(0, 120),
    }).eq("id", conv.id);

    return { ok: true, id: externalId };
  });

// ---------- delete message ----------
// Apaga a mensagem: se outbound, chama /message/delete na uazapi (apaga pra todos).
// Marca metadata.deleted=true e substitui content.
export const deleteUazapiMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ messageId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: msg, error } = await supabaseAdmin
      .from("messages")
      .select("id, direction, external_id, metadata, conversation_id, conversations(channels(credentials), contacts(phone))")
      .eq("id", data.messageId).single();
    if (error || !msg) throw new Error("Mensagem não encontrada");

    if (msg.direction === "outbound") {
      const token = ((msg as any).conversations?.channels?.credentials as any)?.token;
      const shortId = extractShortId(msg.external_id, msg.metadata);
      if (token && shortId) {
        try {
          await uazapiFetch("/message/delete", { token, body: { id: shortId } });
        } catch (e) {
          console.warn("[uazapi delete] falhou:", (e as Error).message);
        }
      }
    }

    const meta = (msg.metadata as any) ?? {};
    await supabaseAdmin.from("messages").update({
      content: "🗑️ Mensagem apagada",
      metadata: { ...meta, deleted: true },
    }).eq("id", msg.id);

    return { ok: true };
  });

// ---------- forward message ----------
// Encaminha uma mensagem existente pra outra conversa (mesmo canal ou não).
// Reenvia como texto ou como mídia (baixando do storage/uazapi conforme o caso).
export const forwardUazapiMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    messageId: z.string().uuid(),
    targetConversationId: z.string().uuid(),
  }))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: msg, error: msgErr } = await supabaseAdmin
      .from("messages")
      .select("id, type, content, external_id, metadata")
      .eq("id", data.messageId).single();
    if (msgErr || !msg) throw new Error("Mensagem não encontrada");

    const { data: conv, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id, assigned_agent_id, contacts(phone), channels(credentials)")
      .eq("id", data.targetConversationId).single();
    if (convErr || !conv) throw new Error("Conversa destino não encontrada");

    const phone = (conv as any).contacts?.phone as string | null;
    if (!phone) throw new Error("Contato destino sem telefone");
    const token = ((conv as any).channels?.credentials as any)?.token;
    if (!token) throw new Error("Canal destino sem token uazapi");

    const isMedia = ["image", "video", "audio", "document"].includes(msg.type);
    const meta: any = msg.metadata ?? {};
    let externalId: string | null = null;
    let previewContent = msg.content ?? "";

    if (isMedia) {
      // 1) tenta URL pública que a uazapi cacheou; 2) URL assinada do bucket;
      // 3) força um download via getMessageMedia lógica → cachedUrl
      let fileUrl: string | undefined = meta?.media?.cachedUrl;
      if (!fileUrl && meta?.media?.storagePath) {
        const { data: s } = await supabaseAdmin.storage
          .from("attachments").createSignedUrl(meta.media.storagePath, 60 * 60);
        fileUrl = s?.signedUrl;
      }
      if (!fileUrl) {
        // último recurso: /message/download
        const shortId = extractShortId(msg.external_id, meta);
        if (shortId) {
          try {
            const dl: any = await uazapiFetch("/message/download", { token, body: { id: shortId } });
            fileUrl = dl?.fileURL ?? dl?.url ?? dl?.mediaUrl ?? dl?.fileUrl;
          } catch { /* fallthrough */ }
        }
      }
      if (!fileUrl) throw new Error("Arquivo original indisponível para encaminhar");

      const mimeType = meta?.media?.mimeType ?? meta?.media?.mimetype ?? "application/octet-stream";
      const filename = meta?.media?.filename ?? "arquivo";
      const kind =
        msg.type === "image" ? "image" :
        msg.type === "video" ? "video" :
        msg.type === "audio" ? "audio" : "document";

      const res = await uazapiFetch("/send/media", {
        token,
        body: {
          number: phone, type: kind, file: fileUrl,
          docName: kind === "document" ? filename : undefined,
          text: "",
        },
      });
      externalId = res?.messageid ?? res?.id ?? null;
      if (externalId) externalId = String(externalId).match(/^\d+:(.+)$/)?.[1] ?? String(externalId);
      previewContent = previewContent || `[${kind}] ${filename}`;

      await supabaseAdmin.from("messages").insert({
        conversation_id: conv.id,
        sender_agent_id: context.userId,
        direction: "outbound",
        type: kind,
        content: previewContent,
        status: "sent",
        external_id: externalId,
        metadata: {
          uazapi: res,
          media: { cachedUrl: fileUrl, mimeType, filename },
          forwarded: true,
        },
      });
    } else {
      const text = (msg.content ?? "").trim();
      if (!text) throw new Error("Mensagem vazia");
      const res = await uazapiFetch("/send/text", {
        token, body: { number: phone, text },
      });
      externalId = res?.messageid ?? res?.id ?? null;
      if (externalId) externalId = String(externalId).match(/^\d+:(.+)$/)?.[1] ?? String(externalId);
      previewContent = text;

      await supabaseAdmin.from("messages").insert({
        conversation_id: conv.id,
        sender_agent_id: context.userId,
        direction: "outbound",
        type: "text",
        content: text,
        status: "sent",
        external_id: externalId,
        metadata: { uazapi: res, forwarded: true },
      });
    }

    await supabaseAdmin.from("conversations").update({
      assigned_agent_id: conv.assigned_agent_id ?? context.userId,
      last_message_at: new Date().toISOString(),
      last_message_preview: previewContent.slice(0, 120),
    }).eq("id", conv.id);

    return { ok: true, id: externalId };
  });

// ---------- sync history ----------
// Importa os chats e o histórico local da uazapi em blocos retomáveis. O
// cursor evita que cada chamada recomece do primeiro chat e nunca alcance os
// mais antigos. Grupos também são materializados como conversas e mantêm o
// JID completo (`@g.us`) como endereço de envio.
export const syncUazapiHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    channelId: z.string().uuid().optional(),
    perChatLimit: z.number().int().min(1).max(10000).optional(),
    cursor: z.object({
      channelIndex: z.number().int().min(0),
      chatIndex: z.number().int().min(0),
      messageOffset: z.number().int().min(0),
    }).optional(),
  }))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { ensureChatConversation, ingestMessage } = await import("./uazapi-ingest.server");
    const { enqueueHistory, runBackfillBatch } = await import("./uazapi-history.server");

    const q = supabaseAdmin
      .from("channels")
      .select("*")
      .eq("type", "whatsapp")
      .order("created_at", { ascending: true });
    if (data.channelId) q.eq("id", data.channelId);
    const { data: channels, error } = await q;
    if (error) throw new Error(error.message);

    const perChatCap = data.perChatLimit ?? 2000;
    const PAGE = 200;
    const deadline = Date.now() + 20_000;
    const outOfTime = () => Date.now() > deadline;
    let ingested = 0;
    let errors = 0;
    let chatsProcessed = 0;
    let chatsFound = 0;
    let groupsFound = 0;
    let historyRequested = 0;
    let webhookErrors = 0;

    const start = data.cursor ?? { channelIndex: 0, chatIndex: 0, messageOffset: 0 };
    const partialResult = (channelIndex: number, chatIndex: number, messageOffset: number) => ({
      ingested,
      errors,
      channels: channels?.length ?? 0,
      chats: chatsProcessed,
      chatsFound,
      groups: groupsFound,
      historyRequested,
      webhookErrors,
      partial: true as const,
      cursor: { channelIndex, chatIndex, messageOffset },
    });

    for (let channelIndex = start.channelIndex; channelIndex < (channels?.length ?? 0); channelIndex++) {
      const ch = channels![channelIndex];
      const token = (ch.credentials as any)?.token;
      if (!token) continue;
      const firstChatIndex = channelIndex === start.channelIndex ? start.chatIndex : 0;
      const firstMessageOffset = channelIndex === start.channelIndex ? start.messageOffset : 0;
      if (outOfTime()) return partialResult(channelIndex, firstChatIndex, firstMessageOffset);

      // Corrige automaticamente webhooks de instâncias já existentes. Sem o
      // evento `history`, o endpoint history-sync aceita a solicitação, mas o
      // AttendFlow nunca recebe as mensagens que chegam depois.
      try {
        await configureUazapiWebhook(ch.id, token);
      } catch (e) {
        webhookErrors++;
        console.warn("[uazapi sync] webhook setup falhou:", (e as Error).message);
      }

      // Lista chats individuais e grupos conhecidos pela instância.
      let chats: any[] = [];
      try {
        const seenChats = new Set<string>();
        const CHAT_PAGE = 100;
        let chatOffset = 0;
        while (chatOffset < 20_000) {
          const res = await uazapiFetch("/chat/find", {
            token,
            body: { operator: "AND", sort: "-wa_lastMsgTimestamp", limit: CHAT_PAGE, offset: chatOffset },
          });
          const page = Array.isArray(res) ? res : res?.chats ?? res?.data ?? [];
          if (!page.length) break;
          for (const chat of page) {
            const chatid = chat?.wa_chatid ?? chat?.chatid ?? chat?.id ?? chat?.jid ?? chat?.remoteJid;
            if (chatid && !seenChats.has(chatid)) {
              seenChats.add(chatid);
              chats.push(chat);
            }
          }
          const nextChatOffset = chatOffset + page.length;
          const totalRecords = Number(res?.pagination?.totalRecords);
          if (nextChatOffset <= chatOffset) break;
          chatOffset = nextChatOffset;
          if (Number.isFinite(totalRecords) && chatOffset >= totalRecords) break;
        }

        // /group/list é a fonte explícita de todos os grupos. A versão POST
        // permite paginação e evita perder grupos quando a conta possui mais
        // registros do que o limite aplicado pela API.
        try {
          const GROUP_PAGE = 1000;
          let groupOffset = 0;
          while (groupOffset < 20_000) {
            const groupRes = await uazapiFetch("/group/list", {
              token,
              body: {
                limit: GROUP_PAGE,
                offset: groupOffset,
                force: !data.cursor && groupOffset === 0,
                noParticipants: true,
              },
            });
            const groups = Array.isArray(groupRes)
              ? groupRes
              : groupRes?.groups ?? groupRes?.data?.groups ?? groupRes?.data ?? [];
            if (!groups.length) break;
            for (const group of groups) {
              const groupJid = group?.JID ?? group?.jid ?? group?.groupjid ?? group?.id;
              if (!groupJid || seenChats.has(groupJid)) continue;
              seenChats.add(groupJid);
              chats.push({
                ...group,
                wa_chatid: groupJid,
                wa_isGroup: true,
                wa_name: group?.Name ?? group?.name ?? group?.subject ?? "",
              });
            }
            const nextGroupOffset = groupOffset + groups.length;
            const totalGroups = Number(groupRes?.pagination?.totalRecords);
            if (nextGroupOffset <= groupOffset) break;
            groupOffset = nextGroupOffset;
            if (Number.isFinite(totalGroups) && groupOffset >= totalGroups) break;
          }
        } catch (e) {
          console.warn("[uazapi sync] group/list falhou:", (e as Error).message);
        }
      } catch (e) {
        console.warn("[uazapi sync] chat/find falhou:", (e as Error).message);
      }

      chatsFound += chats.length;
      groupsFound += chats.filter((chat) =>
        Boolean(chat?.wa_isGroup || chat?.isGroup || String(chat?.wa_chatid ?? chat?.JID ?? "").includes("@g.us")),
      ).length;

      // Se a listagem de chats falhar, ainda tenta importar o feed global.
      if (!chats.length) {
        try {
          const res = await uazapiFetch("/message/find", {
            token,
            body: { limit: 500 },
          });
          const msgs = Array.isArray(res) ? res : res?.messages ?? res?.data ?? [];
          for (const m of [...msgs].reverse()) {
            try {
              if (await ingestMessage(supabaseAdmin, ch.id, m)) ingested++;
            }
            catch (e) { errors++; console.error("[uazapi sync] ingest err:", (e as Error).message); }
          }
        } catch (e) {
          console.warn("[uazapi sync] message/find global falhou:", (e as Error).message);
          errors++;
        }
        continue;
      }

      for (let chatIndex = firstChatIndex; chatIndex < chats.length; chatIndex++) {
        const chat = chats[chatIndex];
        let offset = chatIndex === firstChatIndex ? firstMessageOffset : 0;
        if (outOfTime()) return partialResult(channelIndex, chatIndex, offset);

        const chatid: string | undefined =
          chat?.wa_chatid ?? chat?.chatid ?? chat?.JID ?? chat?.groupjid ?? chat?.jid ?? chat?.remoteJid;
        if (
          !chatid ||
          chatid.includes("@broadcast") ||
          chatid.includes("@newsletter")
        ) continue;

        let ensured: any = null;
        try {
          ensured = await ensureChatConversation(supabaseAdmin, ch.id, chat);
        } catch (e) {
          errors++;
          console.error("[uazapi sync] ensure chat err:", chatid, (e as Error).message);
        }

        let exhaustedLocally = false;
        while (offset < perChatCap) {
          if (outOfTime()) return partialResult(channelIndex, chatIndex, offset);
          let res: any;
          try {
            res = await uazapiFetch("/message/find", {
              token,
              body: { chatid, limit: PAGE, offset },
            });
          } catch (e) {
            console.warn("[uazapi sync] message/find falhou:", (e as Error).message);
            errors++;
            break;
          }
          const page: any[] = Array.isArray(res) ? res : res?.messages ?? res?.data ?? [];
          if (!page.length) { exhaustedLocally = true; break; }
          for (const m of [...page].reverse()) {
            try {
              if (await ingestMessage(supabaseAdmin, ch.id, m, chat)) ingested++;
            }
            catch (e) { errors++; console.error("[uazapi sync] ingest err:", (e as Error).message); }
          }
          if (res?.hasMore === false) { exhaustedLocally = true; break; }
          const nextOffset = typeof res?.nextOffset === "number" ? res.nextOffset : offset + page.length;
          if (nextOffset <= offset) {
            errors++;
            console.warn("[uazapi sync] paginação sem avanço:", chatid, offset, nextOffset);
            break;
          }
          offset = nextOffset;
          if (res?.hasMore === undefined && page.length < PAGE) { exhaustedLocally = true; break; }
        }
        chatsProcessed++;

        // Histórico anterior ao cache local (~7 dias): entra na fila do
        // history-sync, que segue next_request até has_more:false.
        if (exhaustedLocally) {
          try {
            const convId = ensured?.conversationId;
            if (convId) {
              await enqueueHistory(supabaseAdmin, convId, ch.id, chatid);
              historyRequested++;
            }
          } catch (e) {
            console.warn("[uazapi sync] enqueue history falhou:", chatid, (e as Error).message);
          }
        }
      }
    }

    // Fila: chats mais recentes primeiro; o restante segue pelo cron.
    try { await supabaseAdmin.rpc("arm_history_backfill" as any); } catch (e) {
      console.warn("[uazapi sync] arm backfill falhou:", (e as Error).message);
    }
    if (!outOfTime()) {
      try {
        await runBackfillBatch(supabaseAdmin, { deadline, pages: 1, reserveMs: 0, limit: 3, channelId: data.channelId });
      } catch (e) {
        console.warn("[uazapi sync] backfill batch falhou:", (e as Error).message);
      }
    }

    return {
      ingested,
      errors,
      channels: channels?.length ?? 0,
      chats: chatsProcessed,
      chatsFound,
      groups: groupsFound,
      historyRequested,
      webhookErrors,
      partial: false as const,
      cursor: null,
    };
  });

// ---------- histórico antigo sob demanda ----------
export const loadOlderMessages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ conversationId: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    // RLS: só segue se o usuário enxerga a conversa.
    const { data: visible } = await context.supabase
      .from("conversations").select("id").eq("id", data.conversationId).maybeSingle();
    if (!visible) throw new Error("Conversa não encontrada");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { pullOlderHistory } = await import("./uazapi-history.server");
    const r = await pullOlderHistory(supabaseAdmin, data.conversationId, { pages: 1 });
    return { added: r.added, hasMore: r.hasMore, status: r.status };
  });

export const getHistoryBackfillStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ channelId: z.string().uuid().optional() }))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const base = () => {
      let q = sb.from("history_sync_state").select("conversation_id", { count: "exact", head: true });
      if (data.channelId) q = q.eq("channel_id", data.channelId);
      return q;
    };
    const [total, finished, errored] = await Promise.all([
      base(),
      base().in("status", ["done", "blocked"]),
      base().eq("status", "error"),
    ]);
    let rq = sb.from("history_sync_state").select("fetched_count, last_error, updated_at")
      .order("updated_at", { ascending: false }).limit(5000);
    if (data.channelId) rq = rq.eq("channel_id", data.channelId);
    const { data: rows } = await rq;
    const imported = (rows ?? []).reduce((s: number, r: any) => s + (r.fetched_count ?? 0), 0);
    const lastError = (rows ?? []).find((r: any) => r.last_error)?.last_error ?? null;

    // Fase da descoberta automática (disparada ao conectar o número).
    let discoveryPhase: string | null = null;
    if (data.channelId) {
      const { data: ch } = await sb
        .from("channels").select("history_discovery").eq("id", data.channelId).maybeSingle();
      discoveryPhase = ((ch as any)?.history_discovery?.phase as string) ?? null;
    }
    return {
      total: total.count ?? 0,
      finished: finished.count ?? 0,
      errored: errored.count ?? 0,
      imported,
      lastError,
      discoveryPhase,
    };
  });

// ---------- get media URL for a message ----------
export const getMessageMedia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ messageId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { resolveMessageMediaToStorage } = await import("./uazapi-media.server");

    const media = await resolveMessageMediaToStorage(supabaseAdmin, data.messageId);

    // URL assinada direta do Storage (CDN Supabase) — sem passar pelo proxy TSS.
    const { data: signed, error: signErr } = await supabaseAdmin.storage
      .from("attachments")
      .createSignedUrl(media.storagePath, 60 * 60);
    if (signErr || !signed?.signedUrl) {
      throw new Error(`Falha ao assinar URL: ${signErr?.message ?? "sem URL"}`);
    }

    return {
      url: signed.signedUrl,
      mimeType: media.mimeType,
      filename: media.filename,
    };
  });

// re-export para conveniência de consumidores que queiram tipar
export { CHANNEL_PUBLIC_COLS };
