import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";

// Comparação em tempo constante (evita descobrir o token por tempo de resposta).
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export const Route = createFileRoute("/api/public/uazapi-webhook/$channelId")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const channelId = params.channelId;
        let payload: any;
        try { payload = await request.json(); } catch { return new Response("bad json", { status: 400 }); }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // valida canal
        const { data: channel } = await supabaseAdmin
          .from("channels").select("id, credentials").eq("id", channelId).single();
        if (!channel) return new Response("channel not found", { status: 404 });

        // valida token da instância (uazapi envia no payload ou no header)
        const expectedToken = (channel.credentials as any)?.token;
        const providedToken =
          request.headers.get("token") ??
          request.headers.get("x-token") ??
          payload?.token ??
          payload?.instance?.token ??
          payload?.data?.token;
        if (!expectedToken || !safeEqual(String(providedToken ?? ""), String(expectedToken))) {
          console.warn("[uazapi webhook] token inválido para canal", channelId);
          return new Response("unauthorized", { status: 401 });
        }

        // Carona no tráfego de webhooks pra despachar follow-ups vencidos
        // (mensagens automáticas agendadas pelas tags — ex: aguardando 24h).
        try {
          const { processDueFollowups } = await import("@/lib/followups.server");
          await processDueFollowups(supabaseAdmin, 3);
        } catch (e) {
          console.error("[uazapi webhook] followups err:", (e as Error).message);
        }

        const eventLower = extractEventName(payload).toLowerCase();

        // Evento final do history-sync assíncrono: status/has_more/next_request.
        // Precisa vir antes do ramo de conexão, senão `includes("status")` o engole.
        const hs = payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)
          ? { ...payload.data, ...payload } : payload;
        const isHistoryStatus =
          eventLower !== "history" &&
          (hs?.request_id !== undefined || hs?.requestId !== undefined ||
            hs?.has_more !== undefined || hs?.next_request !== undefined);
        if (isHistoryStatus) {
          try {
            const { applyHistoryStatus } = await import("@/lib/uazapi-history.server");
            const reqId = hs?.request_id ?? hs?.requestId;
            let q = supabaseAdmin.from("history_sync_state").select("conversation_id").eq("channel_id", channelId);
            const chatJid = hs?.number ?? hs?.chatid ?? hs?.chat_jid;
            if (reqId) q = q.eq("request_id", String(reqId));
            else if (chatJid) q = q.eq("chat_jid", String(chatJid));
            else q = q.eq("conversation_id", "00000000-0000-0000-0000-000000000000");
            const { data: rows } = await q.limit(1);
            if (rows?.[0]) await applyHistoryStatus(supabaseAdmin, rows[0].conversation_id, hs);
          } catch (e) {
            console.error("[uazapi webhook] history status err:", (e as Error).message);
          }
          return new Response("ok");
        }

        // Eventos de conexão
        if (eventLower.includes("connection") || eventLower.includes("status")) {
          const raw = payload?.data?.status ?? payload?.status;
          const mapped =
            raw === "connected" ? "connected"
            : raw === "connecting" ? "connecting"
            : raw === "disconnected" ? "disconnected"
            : null;
          if (mapped) {
            const patch: any = { status: mapped };
            if (mapped === "connected") { patch.qr_code = null; patch.last_connected_at = new Date().toISOString(); }
            await supabaseAdmin.from("channels").update(patch).eq("id", channelId);
            // Número conectou → dispara a descoberta automática de TODAS as
            // conversas e o backfill do histórico (roda no servidor, via cron).
            if (mapped === "connected") {
              try {
                const { startAutoHistory } = await import("@/lib/uazapi-discovery.server");
                await startAutoHistory(supabaseAdmin, channelId);
              } catch (e) {
                console.error("[uazapi webhook] auto-history start err:", (e as Error).message);
              }
            }
          }
          return new Response("ok");
        }
        if (eventLower.includes("qrcode") || eventLower.includes("qr")) {
          const qr = payload?.data?.qrcode ?? payload?.qrcode ?? payload?.qr;
          if (qr) await supabaseAdmin.from("channels")
            .update({ qr_code: qr, status: "connecting" }).eq("id", channelId);
          return new Response("ok");
        }

        // ACK / status updates (messages_update, message_ack, receipt)
        if (
          eventLower.includes("messages_update") ||
          eventLower.includes("message_update") ||
          eventLower.includes("ack") ||
          eventLower.includes("receipt")
        ) {
          const updates = extractStatusUpdates(payload);
          for (const u of updates) {
            try {
              const mapped = mapAckStatus(u.status);
              if (!mapped || !u.externalId) continue;
              await supabaseAdmin
                .from("messages")
                .update({ status: mapped })
                .eq("external_id", u.externalId);
            } catch (e) { console.error("[uazapi webhook] ack err:", e); }
          }
          return new Response("ok");
        }

        // Mantém novos grupos, renomeações e atualizações de chats visíveis
        // mesmo antes de chegar uma mensagem nova.
        if (eventLower.includes("group") || eventLower === "chats" || eventLower === "chat") {
          const { ensureChatConversation } = await import("@/lib/uazapi-ingest.server");
          for (const chat of extractChats(payload)) {
            try { await ensureChatConversation(supabaseAdmin, channelId, chat); }
            catch (e) { console.error("[uazapi webhook] ensure chat err:", e); }
          }
          return new Response("ok");
        }

        // Mensagens
        const { ingestMessage } = await import("@/lib/uazapi-ingest.server");
        const messages = extractMessages(payload);

        for (const m of messages) {
          try { await ingestMessage(supabaseAdmin, channelId, m); }
          catch (e) { console.error("[uazapi webhook] ingest err:", e); }
        }

        // Evento history com request_id: soma fetched_count e recua oldest_message_at.
        const histReqId = hs?.request_id ?? hs?.requestId;
        if (eventLower === "history" && histReqId && messages.length) {
          try {
            const { data: rows } = await supabaseAdmin.from("history_sync_state")
              .select("conversation_id, fetched_count, oldest_message_at")
              .eq("channel_id", channelId).eq("request_id", String(histReqId)).limit(1);
            const row: any = rows?.[0];
            if (row) {
              let oldest: string | null = row.oldest_message_at;
              for (const m of messages) {
                const ts = Number(m?.messageTimestamp ?? m?.timestamp ?? m?.t);
                if (Number.isFinite(ts) && ts > 0) {
                  const iso = new Date(ts > 1e12 ? ts : ts * 1000).toISOString();
                  if (!oldest || iso < oldest) oldest = iso;
                }
              }
              await supabaseAdmin.from("history_sync_state").update({
                fetched_count: (row.fetched_count ?? 0) + messages.length,
                oldest_message_at: oldest,
                attempts: 0,
                last_activity_at: new Date().toISOString(),
              }).eq("conversation_id", row.conversation_id);
            }
          } catch (e) { console.error("[uazapi webhook] history counters err:", (e as Error).message); }
        }
        return new Response("ok");
      },
    },
  },
});

function stringifyEventPart(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    return (
      stringifyEventPart(value.type) ||
      stringifyEventPart(value.event) ||
      stringifyEventPart(value.name) ||
      stringifyEventPart(value.action) ||
      stringifyEventPart(value.status)
    );
  }
  return "";
}

function extractEventName(payload: any): string {
  return (
    stringifyEventPart(payload?.event) ||
    stringifyEventPart(payload?.type) ||
    stringifyEventPart(payload?.EventType) ||
    stringifyEventPart(payload?.eventType) ||
    stringifyEventPart(payload?.data?.event) ||
    stringifyEventPart(payload?.data?.type)
  );
}

function toMessageArray(value: any): any[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function looksLikeMessage(value: any): boolean {
  if (!value || typeof value !== "object") return false;
  return Boolean(
    value.key ||
    value.remoteJid ||
    value.chatid ||
    value.chatId ||
    value.from ||
    value.sender ||
    value.messageid ||
    value.messageId ||
    value.message ||
    value.text ||
    value.body ||
    value.content ||
    value.messageType ||
    value.mediaUrl,
  );
}

function extractMessages(payload: any): any[] {
  const candidates = [
    ...toMessageArray(payload?.data?.history),
    ...toMessageArray(payload?.data?.messages),
    ...toMessageArray(payload?.data?.message),
    ...toMessageArray(payload?.data),
    ...toMessageArray(payload?.messages),
    ...toMessageArray(payload?.message),
    ...toMessageArray(payload?.event?.messages),
    ...toMessageArray(payload?.event?.message),
    ...toMessageArray(payload?.event?.data),
    ...toMessageArray(payload?.history),
  ];
  const messages = candidates.filter(looksLikeMessage);
  if (!messages.length && looksLikeMessage(payload)) return [payload];
  return messages;
}

function looksLikeChat(value: any): boolean {
  if (!value || typeof value !== "object") return false;
  return Boolean(
    value.wa_chatid || value.chatid || value.JID || value.groupjid || value.jid || value.remoteJid,
  );
}

function extractChats(payload: any): any[] {
  const candidates = [
    ...toMessageArray(payload?.data?.groups),
    ...toMessageArray(payload?.data?.group),
    ...toMessageArray(payload?.data?.chats),
    ...toMessageArray(payload?.data?.chat),
    ...toMessageArray(payload?.data),
    ...toMessageArray(payload?.groups),
    ...toMessageArray(payload?.group),
    ...toMessageArray(payload?.chats),
    ...toMessageArray(payload?.chat),
    ...toMessageArray(payload?.event?.data),
  ];
  return candidates.filter(looksLikeChat);
}

function mapAckStatus(raw: any): "sent" | "delivered" | "read" | "failed" | null {
  if (raw === null || raw === undefined) return null;
  // Baileys/uazapi numeric ack: 0=pending 1=sent 2=delivered 3=read 4=played 5=error
  if (typeof raw === "number") {
    if (raw === 1) return "sent";
    if (raw === 2) return "delivered";
    if (raw >= 3 && raw <= 4) return "read";
    if (raw === 5) return "failed";
    return null;
  }
  const s = String(raw).toLowerCase();
  if (s.includes("read") || s.includes("played")) return "read";
  if (s.includes("deliver")) return "delivered";
  if (s.includes("sent") || s === "server_ack") return "sent";
  if (s.includes("error") || s.includes("fail")) return "failed";
  return null;
}

function extractStatusUpdates(payload: any): Array<{ externalId: string; status: any }> {
  const buckets: any[] = [
    ...toMessageArray(payload?.data?.updates),
    ...toMessageArray(payload?.updates),
    ...toMessageArray(payload?.data?.messages),
    ...toMessageArray(payload?.data?.message),
    ...toMessageArray(payload?.data),
    ...toMessageArray(payload?.messages),
    ...toMessageArray(payload?.message),
    ...toMessageArray(payload?.event?.messages),
    ...toMessageArray(payload?.event?.data),
    payload,
  ];
  const out: Array<{ externalId: string; status: any }> = [];
  const seen = new Set<string>();
  for (const b of buckets) {
    if (!b || typeof b !== "object") continue;
    const id =
      b?.key?.id ?? b?.messageid ?? b?.messageId ?? b?.id ??
      b?.message?.key?.id ?? b?.update?.key?.id;
    const status =
      b?.status ?? b?.ack ?? b?.update?.status ?? b?.update?.ack ??
      b?.receipt?.type ?? b?.messageStatus;
    if (!id || status === undefined || status === null) continue;
    const key = `${id}:${status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ externalId: String(id), status });
  }
  return out;
}
