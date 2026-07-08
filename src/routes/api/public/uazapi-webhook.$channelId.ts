import { createFileRoute } from "@tanstack/react-router";

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
        if (!expectedToken || providedToken !== expectedToken) {
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

        // Mensagens
        const { ingestMessage } = await import("@/lib/uazapi-ingest.server");
        const messages = extractMessages(payload);

        for (const m of messages) {
          try { await ingestMessage(supabaseAdmin, channelId, m); }
          catch (e) { console.error("[uazapi webhook] ingest err:", e); }
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
    ...toMessageArray(payload?.data?.messages),
    ...toMessageArray(payload?.data?.message),
    ...toMessageArray(payload?.data),
    ...toMessageArray(payload?.messages),
    ...toMessageArray(payload?.message),
    ...toMessageArray(payload?.event?.messages),
    ...toMessageArray(payload?.event?.message),
    ...toMessageArray(payload?.event?.data),
  ];
  const messages = candidates.filter(looksLikeMessage);
  if (!messages.length && looksLikeMessage(payload)) return [payload];
  return messages;
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
