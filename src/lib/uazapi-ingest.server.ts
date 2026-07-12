// Server-only helper: ingesta mensagens da uazapi no banco.
// Usado tanto pelo webhook público quanto pelo endpoint de sync manual.

function extractPhone(jid?: string): string | null {
  if (!jid) return null;
  const p = jid.split("@")[0]?.split(":")[0];
  return p && /^\d+$/.test(p) ? p : null;
}

function extractText(m: any): string {
  return (
    m?.text ??
    m?.caption ??
    m?.message?.text ??
    m?.message?.conversation ??
    m?.message?.extendedTextMessage?.text ??
    m?.message?.textMessage?.text ??
    m?.message?.imageMessage?.caption ??
    m?.message?.videoMessage?.caption ??
    m?.message?.documentMessage?.caption ??
    m?.msgContent?.conversation ??
    m?.msgContent?.extendedTextMessage?.text ??
    m?.msgContent?.imageMessage?.caption ??
    m?.msgContent?.videoMessage?.caption ??
    m?.msgContent?.documentMessage?.caption ??
    m?.textMessage?.text ??
    m?.content?.text ??
    m?.body ??
    (typeof m?.content === "string" ? m.content : "") ??
    ""
  );
}

// Detecta se é mídia e retorna { type, url, mimetype, filename } quando possível.
function extractMedia(m: any): {
  type: "image" | "video" | "audio" | "document" | null;
  url?: string;
  mimetype?: string;
  filename?: string;
} {
  const msg = m?.message ?? m?.msgContent ?? {};

  const map: Record<string, "image" | "video" | "audio" | "document"> = {
    imageMessage: "image",
    videoMessage: "video",
    audioMessage: "audio",
    documentMessage: "document",
    stickerMessage: "image",
    ptvMessage: "video",
  };
  for (const [k, t] of Object.entries(map)) {
    const node = msg?.[k];
    if (node && typeof node === "object") {
      return {
        type: t,
        url: node.url ?? node.directPath ?? node.mediaUrl,
        mimetype: node.mimetype ?? node.mimeType,
        filename: node.fileName ?? node.filename ?? node.title,
      };
    }
  }

  // Formato flat da uazapi (messageType + content.*)
  const flatType = (m?.messageType ?? m?.mediaType ?? m?.type ?? "").toString().toLowerCase();
  const flatMap: Record<string, "image" | "video" | "audio" | "document"> = {
    image: "image",
    imagemessage: "image",
    sticker: "image",
    stickermessage: "image",
    video: "video",
    videomessage: "video",
    ptv: "video",
    ptvmessage: "video",
    audio: "audio",
    audiomessage: "audio",
    ptt: "audio",
    pttmessage: "audio",
    document: "document",
    documentmessage: "document",
    file: "document",
  };
  const content = m?.content ?? {};
  if (flatMap[flatType]) {
    return {
      type: flatMap[flatType],
      url: content.url ?? content.URL ?? content.directPath ?? m?.mediaUrl ?? m?.url ?? m?.file,
      mimetype: content.mimetype ?? content.mimeType ?? m?.mimetype ?? m?.mimeType,
      filename:
        content.fileName ??
        content.filename ??
        content.title ??
        m?.fileName ??
        m?.filename ??
        m?.docName,
    };
  }

  return { type: null };
}

export async function ingestMessage(sb: any, channelId: string, m: any) {
  const key = m?.key ?? m;
  const remoteJid: string | undefined =
    key?.remoteJid ?? m?.remoteJid ?? m?.chatid ?? m?.chatId ?? m?.from ?? m?.sender ?? m?.jid;
  const fromMe: boolean = Boolean(key?.fromMe ?? m?.fromMe ?? m?.from_me);
  const externalId: string | undefined =
    key?.id ?? m?.id ?? m?.messageid ?? m?.messageId ?? m?.message_id;
  const pushName: string | undefined = m?.pushName ?? m?.senderName ?? m?.name ?? m?.sender_name;
  const timestamp: number | undefined = m?.messageTimestamp ?? m?.timestamp ?? m?.t;

  const phone = extractPhone(remoteJid);
  if (!phone) return;
  if (remoteJid?.includes("@g.us")) return; // ignora grupos

  if (externalId) {
    const { data: dup } = await sb
      .from("messages")
      .select("id")
      .eq("external_id", externalId)
      .maybeSingle();
    if (dup) return;
  }

  const caption = extractText(m);
  const media = extractMedia(m);
  const isMedia = media.type !== null;

  // Se não é mídia e não tem texto, ignora
  if (!isMedia && !caption) return;

  const msgType = isMedia ? media.type! : "text";
  const previewLabel =
    msgType === "image"
      ? "📷 Imagem"
      : msgType === "video"
        ? "🎥 Vídeo"
        : msgType === "audio"
          ? "🎵 Áudio"
          : msgType === "document"
            ? `📄 ${media.filename || "Documento"}`
            : "";
  const content = caption || previewLabel || "[mídia]";

  // Contato único por telefone (índice contacts_phone_unique).
  // Em caso de race entre webhooks paralelos, o INSERT perde pro índice
  // único (23505) e re-busca o vencedor.
  // IMPORTANTE: pushName em mensagens outbound (fromMe) é o dono da conta,
  // não o cliente. Só usamos pushName quando a mensagem é inbound.
  const contactName = !fromMe && pushName ? pushName : null;
  let contactId: string;
  const { data: existing } = await sb
    .from("contacts")
    .select("id, name")
    .eq("phone", phone)
    .maybeSingle();
  if (existing) {
    contactId = existing.id;
    // Atualiza nome se o atual é só o telefone e agora temos um nome real
    if (contactName && (!existing.name || existing.name === phone)) {
      await sb.from("contacts").update({ name: contactName }).eq("id", contactId);
    }
  } else {
    const { data: created, error } = await sb
      .from("contacts")
      .insert({
        name: contactName || phone,
        phone,
        source_channel_id: channelId,
        external_id: remoteJid,
      })
      .select("id")
      .single();
    if (error && (error as any).code === "23505") {
      const { data: winner } = await sb.from("contacts").select("id").eq("phone", phone).single();
      contactId = winner.id;
    } else if (error) {
      throw error;
    } else {
      contactId = created.id;
    }
  }

  // Modelo WhatsApp: UMA conversa por (contato + canal), pra sempre.
  // Mensagem nova em conversa resolvida REABRE a mesma conversa
  // (em vez de criar outra — que era o que duplicava as janelas).
  let conversationId: string;
  let unread = 0;
  let lastMessageAt: string | null = null;
  let wasResolved = false;
  let isNewConv = false;
  let currentTags: string[] | null = null;
  let botActive = false;
  const { data: conv } = await sb
    .from("conversations")
    .select("id, unread_count, status, last_message_at, tags, bot_active")
    .eq("contact_id", contactId)
    .eq("channel_id", channelId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (conv) {
    conversationId = conv.id;
    unread = conv.unread_count ?? 0;
    lastMessageAt = conv.last_message_at ?? null;
    currentTags = conv.tags ?? [];
    botActive = Boolean(conv.bot_active);
    if (!fromMe && (conv.status === "resolved" || conv.status === "closed")) {
      wasResolved = true;
      await sb
        .from("conversations")
        .update({
          status: "open",
          resolved_at: null,
          resolved_by: null,
          last_opened_at: new Date().toISOString(),
        })
        .eq("id", conv.id);
    }
  } else {
    isNewConv = true;
    const { data: newConv, error } = await sb
      .from("conversations")
      .insert({ contact_id: contactId, channel_id: channelId, status: "open" })
      .select("id")
      .single();
    if (error && (error as any).code === "23505") {
      const { data: winner } = await sb
        .from("conversations")
        .select("id, unread_count, last_message_at, tags, bot_active")
        .eq("contact_id", contactId)
        .eq("channel_id", channelId)
        .single();
      conversationId = winner.id;
      unread = winner.unread_count ?? 0;
      lastMessageAt = winner.last_message_at ?? null;
      currentTags = winner.tags ?? [];
      botActive = Boolean(winner.bot_active);
      isNewConv = false;
    } else if (error) {
      throw error;
    } else {
      conversationId = newConv.id;
    }
  }

  if (!fromMe) {
    await sb
      .from("tag_followups")
      .update({ status: "cancelled" })
      .eq("conversation_id", conversationId)
      .eq("status", "pending");
  }

  const createdAt = timestamp
    ? new Date(timestamp > 1e12 ? timestamp : timestamp * 1000).toISOString()
    : undefined;

  const insertRow: any = {
    conversation_id: conversationId,
    direction: fromMe ? "outbound" : "inbound",
    type: msgType,
    content,
    external_id: externalId,
    status: "delivered",
    metadata: {
      raw: m,
      ...(isMedia
        ? { media: { url: media.url, mimetype: media.mimetype, filename: media.filename } }
        : {}),
    },
  };
  if (createdAt) insertRow.created_at = createdAt;

  const { error: insertErr } = await sb.from("messages").insert(insertRow);
  if (insertErr && (insertErr as any).code !== "23505") throw insertErr;
  if (insertErr) return;

  // Mensagem histórica (sync manual ou /message/history-sync reenvia antigas
  // em rajada): não conta como não-lida nem sobrescreve o preview se a
  // conversa já tem mensagem mais recente.
  const effectiveAt = createdAt ?? new Date().toISOString();
  const isHistorical = Date.now() - new Date(effectiveAt).getTime() > 2 * 60_000;
  const isNewest = !lastMessageAt || effectiveAt >= lastMessageAt;

  const patch: any = {};
  if (isNewest) {
    patch.last_message_at = effectiveAt;
    patch.last_message_preview = content.slice(0, 120);
  }
  if (!fromMe && !isHistorical) patch.unread_count = unread + 1;
  if (Object.keys(patch).length) {
    await sb.from("conversations").update(patch).eq("id", conversationId);
  }

  // Chatbot de boas-vindas: só para inbound real (não histórico) e texto.
  if (!fromMe && !isHistorical) {
    try {
      const { data: channelRow } = await sb
        .from("channels").select("credentials").eq("id", channelId).single();
      const token = (channelRow?.credentials as any)?.token;
      if (token) {
        const { runWelcomeBot } = await import("./bot.server");
        await runWelcomeBot(sb, {
          conversationId,
          channelId,
          phone,
          incomingText: caption || "",
          shouldGreet: isNewConv || wasResolved,
          currentTags,
          botActive,
          token,
        });
      }
    } catch (e) {
      console.error("[welcome-bot] erro:", (e as Error).message);
    }
  }
}
