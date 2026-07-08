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
    image: "image", imagemessage: "image", sticker: "image", stickermessage: "image",
    video: "video", videomessage: "video", ptv: "video", ptvmessage: "video",
    audio: "audio", audiomessage: "audio", ptt: "audio", pttmessage: "audio",
    document: "document", documentmessage: "document", file: "document",
  };
  const content = m?.content ?? {};
  if (flatMap[flatType]) {
    return {
      type: flatMap[flatType],
      url: content.url ?? content.URL ?? content.directPath ?? m?.mediaUrl ?? m?.url ?? m?.file,
      mimetype: content.mimetype ?? content.mimeType ?? m?.mimetype ?? m?.mimeType,
      filename: content.fileName ?? content.filename ?? content.title ?? m?.fileName ?? m?.filename ?? m?.docName,
    };
  }

  return { type: null };
}

export async function ingestMessage(sb: any, channelId: string, m: any) {
  const key = m?.key ?? m;
  const remoteJid: string | undefined =
    key?.remoteJid ?? m?.remoteJid ?? m?.chatid ?? m?.chatId ??
    m?.from ?? m?.sender ?? m?.jid;
  const fromMe: boolean = Boolean(key?.fromMe ?? m?.fromMe ?? m?.from_me);
  const externalId: string | undefined =
    key?.id ?? m?.id ?? m?.messageid ?? m?.messageId ?? m?.message_id;
  const pushName: string | undefined =
    m?.pushName ?? m?.senderName ?? m?.name ?? m?.sender_name;
  const timestamp: number | undefined =
    m?.messageTimestamp ?? m?.timestamp ?? m?.t;

  const phone = extractPhone(remoteJid);
  if (!phone) return;
  if (remoteJid?.includes("@g.us")) return; // ignora grupos

  if (externalId) {
    const { data: dup } = await sb
      .from("messages").select("id").eq("external_id", externalId).maybeSingle();
    if (dup) return;
  }

  const caption = extractText(m);
  const media = extractMedia(m);
  const isMedia = media.type !== null;

  // Se não é mídia e não tem texto, ignora
  if (!isMedia && !caption) return;

  const msgType = isMedia ? media.type! : "text";
  const previewLabel =
    msgType === "image" ? "📷 Imagem" :
    msgType === "video" ? "🎥 Vídeo" :
    msgType === "audio" ? "🎵 Áudio" :
    msgType === "document" ? `📄 ${media.filename || "Documento"}` :
    "";
  const content = caption || previewLabel || "[mídia]";

  // upsert contato (por telefone — sistema single-tenant)
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

  // conversa aberta para o par (contato + canal)
  let conversationId: string;
  let unread = 0;
  const { data: openConv } = await sb.from("conversations")
    .select("id, unread_count")
    .eq("contact_id", contactId).eq("channel_id", channelId)
    .neq("status", "resolved")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (openConv) {
    conversationId = openConv.id;
    unread = openConv.unread_count ?? 0;
  } else {
    const { data: newConv, error } = await sb.from("conversations")
      .insert({ contact_id: contactId, channel_id: channelId, status: "open" })
      .select("id").single();
    if (error) throw error;
    conversationId = newConv.id;
  }

  const createdAt = timestamp
    ? new Date((timestamp > 1e12 ? timestamp : timestamp * 1000)).toISOString()
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
      ...(isMedia ? { media: { url: media.url, mimetype: media.mimetype, filename: media.filename } } : {}),
    },
  };
  if (createdAt) insertRow.created_at = createdAt;

  const { error: insertErr } = await sb.from("messages").insert(insertRow);
  if (insertErr && (insertErr as any).code !== "23505") throw insertErr;
  if (insertErr) return;

  await sb.from("conversations").update({
    last_message_at: createdAt ?? new Date().toISOString(),
    last_message_preview: content.slice(0, 120),
    unread_count: fromMe ? unread : unread + 1,
  }).eq("id", conversationId);
}
