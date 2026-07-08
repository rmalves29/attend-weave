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

        const event: string = payload?.event ?? payload?.type ?? "";
        const eventLower = event.toLowerCase();

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

        // Mensagens
        const messages: any[] = Array.isArray(payload?.data) ? payload.data
          : payload?.data ? [payload.data]
          : payload?.messages ?? [];
        if (!messages.length && payload?.message) messages.push(payload);

        for (const m of messages) {
          try { await ingestMessage(supabaseAdmin, channelId, m); }
          catch (e) { console.error("[uazapi webhook] ingest err:", e); }
        }
        return new Response("ok");
      },
    },
  },
});

function extractPhone(jid?: string): string | null {
  if (!jid) return null;
  const p = jid.split("@")[0]?.split(":")[0];
  return p && /^\d+$/.test(p) ? p : null;
}

function extractText(m: any): string {
  return (
    m?.text ??
    m?.message?.conversation ??
    m?.message?.extendedTextMessage?.text ??
    m?.body ??
    m?.content ??
    ""
  );
}

async function ingestMessage(sb: any, channelId: string, m: any) {
  const key = m?.key ?? m;
  const remoteJid: string | undefined = key?.remoteJid ?? m?.chatid ?? m?.from ?? m?.sender;
  const fromMe: boolean = Boolean(key?.fromMe ?? m?.fromMe);
  const externalId: string | undefined = key?.id ?? m?.id ?? m?.messageid;
  const pushName: string | undefined = m?.pushName ?? m?.senderName ?? m?.name;

  const phone = extractPhone(remoteJid);
  if (!phone) return;
  if (remoteJid?.includes("@g.us")) return; // ignora grupos por enquanto

  // Deduplicação: se já ingerimos essa mensagem, pula
  if (externalId) {
    const { data: dup } = await sb
      .from("messages").select("id").eq("external_id", externalId).maybeSingle();
    if (dup) return;
  }

  const content = extractText(m);
  if (!content && !m?.mediaUrl) return;

  // upsert contato (por telefone)
  let contactId: string;
  const { data: existing } = await sb
    .from("contacts").select("id").eq("phone", phone).maybeSingle();
  if (existing) {
    contactId = existing.id;
  } else {
    const { data: created, error } = await sb.from("contacts")
      .insert({
        name: pushName || phone,
        phone,
        source_channel_id: channelId,
        external_id: remoteJid,
      }).select("id").single();
    if (error) throw error;
    contactId = created.id;
  }

  // upsert conversa aberta (contato + canal)
  let conversationId: string;
  const { data: openConv } = await sb.from("conversations")
    .select("id, unread_count")
    .eq("contact_id", contactId).eq("channel_id", channelId)
    .neq("status", "resolved")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (openConv) {
    conversationId = openConv.id;
  } else {
    const { data: newConv, error } = await sb.from("conversations")
      .insert({ contact_id: contactId, channel_id: channelId, status: "open" })
      .select("id").single();
    if (error) throw error;
    conversationId = newConv.id;
  }

  const { error: insertErr } = await sb.from("messages").insert({
    conversation_id: conversationId,
    direction: fromMe ? "outbound" : "inbound",
    type: "text",
    content: content || "[mídia]",
    external_id: externalId,
    status: "delivered",
    metadata: { raw: m },
  });
  // 23505 = unique_violation → mensagem já ingerida em corrida concorrente
  if (insertErr && (insertErr as any).code !== "23505") throw insertErr;
  if (insertErr) return;

  await sb.from("conversations").update({
    last_message_at: new Date().toISOString(),
    last_message_preview: (content || "[mídia]").slice(0, 120),
    unread_count: fromMe ? 0 : ((openConv?.unread_count ?? 0) + 1),
  }).eq("id", conversationId);
}
