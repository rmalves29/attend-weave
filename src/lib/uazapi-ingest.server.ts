// Server-only helper: ingesta mensagens da uazapi no banco.
// Usado tanto pelo webhook público quanto pelo endpoint de sync manual.

function extractPhone(jid?: string): string | null {
  if (!jid) return null;
  const p = jid.split("@")[0]?.split(":")[0];
  return p && /^\d+$/.test(p) ? p : null;
}

function isGroupChat(jid?: string, value?: any): boolean {
  return Boolean(jid?.includes("@g.us") || value?.wa_isGroup || value?.isGroup);
}

function chatAddress(jid?: string, value?: any): string | null {
  if (!jid) return null;
  return isGroupChat(jid, value) ? jid : extractPhone(jid);
}

function chatDisplayName(value: any, group: boolean, fallback: string): string {
  const name = group
    ? value?.Name ?? value?.name ?? value?.wa_name ?? value?.subject ?? value?.groupSubject
    : value?.wa_contactName ?? value?.wa_name ?? value?.lead_name ?? value?.name;
  return String(name ?? "").trim() || (group ? `Grupo ${fallback.split("@")[0]}` : fallback);
}

function chatTimestamp(value: any): string | null {
  const raw = value?.wa_lastMsgTimestamp ?? value?.messageTimestamp ?? value?.timestamp ?? value?.t;
  const timestamp = Number(raw);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp > 1e12 ? timestamp : timestamp * 1000).toISOString();
}

type ConversationState = {
  conversationId: string;
  unread: number;
  lastMessageAt: string | null;
  status: string;
  currentTags: string[];
  botActive: boolean;
  isNewConv: boolean;
};

async function ensureConversationBase(
  sb: any,
  channelId: string,
  input: {
    address: string;
    remoteJid: string;
    name?: string | null;
    avatarUrl?: string | null;
    isGroup: boolean;
  },
): Promise<ConversationState> {
  let contactId: string;
  const { data: existing, error: existingError } = await sb
    .from("contacts")
    .select("id, name, avatar_url, metadata")
    .eq("phone", input.address)
    .maybeSingle();
  if (existingError) throw existingError;

  const whatsappMetadata = {
    ...((existing?.metadata as any)?.whatsapp ?? {}),
    remote_jid: input.remoteJid,
    is_group: input.isGroup,
  };

  if (existing) {
    contactId = existing.id;
    const contactPatch: any = {
      metadata: { ...((existing.metadata as any) ?? {}), whatsapp: whatsappMetadata },
    };
    if (
      input.name &&
      (input.isGroup || !existing.name || existing.name === input.address)
    ) {
      contactPatch.name = input.name;
    }
    if (input.avatarUrl && input.avatarUrl !== existing.avatar_url) {
      contactPatch.avatar_url = input.avatarUrl;
    }
    const { error } = await sb.from("contacts").update(contactPatch).eq("id", contactId);
    if (error) throw error;
  } else {
    const { data: created, error } = await sb
      .from("contacts")
      .insert({
        name: input.name || input.address,
        phone: input.address,
        avatar_url: input.avatarUrl || null,
        source_channel_id: channelId,
        external_id: input.remoteJid,
        metadata: { whatsapp: whatsappMetadata },
      })
      .select("id")
      .single();
    if (error && (error as any).code === "23505") {
      const { data: winner, error: winnerError } = await sb
        .from("contacts")
        .select("id")
        .eq("phone", input.address)
        .single();
      if (winnerError || !winner) throw winnerError ?? error;
      contactId = winner.id;
    } else if (error) {
      throw error;
    } else {
      contactId = created.id;
    }
  }

  const { data: conv, error: conversationError } = await sb
    .from("conversations")
    .select("id, unread_count, status, last_message_at, tags, bot_active")
    .eq("contact_id", contactId)
    .eq("channel_id", channelId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (conversationError) throw conversationError;

  if (conv) {
    return {
      conversationId: conv.id,
      unread: conv.unread_count ?? 0,
      lastMessageAt: conv.last_message_at ?? null,
      status: conv.status,
      currentTags: conv.tags ?? [],
      botActive: Boolean(conv.bot_active),
      isNewConv: false,
    };
  }

  const { data: createdConv, error: createError } = await sb
    .from("conversations")
    .insert({ contact_id: contactId, channel_id: channelId, status: "open" })
    .select("id")
    .single();
  if (createError && (createError as any).code === "23505") {
    const { data: winner, error: winnerError } = await sb
      .from("conversations")
      .select("id, unread_count, status, last_message_at, tags, bot_active")
      .eq("contact_id", contactId)
      .eq("channel_id", channelId)
      .single();
    if (winnerError || !winner) throw winnerError ?? createError;
    return {
      conversationId: winner.id,
      unread: winner.unread_count ?? 0,
      lastMessageAt: winner.last_message_at ?? null,
      status: winner.status,
      currentTags: winner.tags ?? [],
      botActive: Boolean(winner.bot_active),
      isNewConv: false,
    };
  }
  if (createError || !createdConv) throw createError ?? new Error("Falha ao criar conversa");

  return {
    conversationId: createdConv.id,
    unread: 0,
    lastMessageAt: null,
    status: "open",
    currentTags: [],
    botActive: false,
    isNewConv: true,
  };
}

// Garante que todo chat retornado pela uazapi apareça na lista, mesmo que
// ainda não haja mensagens locais para ele. Também preserva o JID completo
// dos grupos para que respostas sejam enviadas ao destino correto.
export async function ensureChatConversation(sb: any, channelId: string, chat: any) {
  const remoteJid: string | undefined =
    chat?.wa_chatid ?? chat?.chatid ?? chat?.JID ?? chat?.groupjid ?? chat?.jid ?? chat?.remoteJid;
  const group = isGroupChat(remoteJid, chat);
  const address = chatAddress(remoteJid, chat);
  if (!remoteJid || !address || remoteJid.includes("@broadcast") || remoteJid === "status@broadcast") {
    return null;
  }

  const state = await ensureConversationBase(sb, channelId, {
    address,
    remoteJid,
    name: chatDisplayName(chat, group, address),
    avatarUrl: chat?.image ?? chat?.imagePreview ?? chat?.PictureUrl ?? null,
    isGroup: group,
  });

  const lastMessageAt = chatTimestamp(chat);
  const preview = String(
    chat?.wa_lastMessageTextVote ?? chat?.lastMessagePreview ?? chat?.lastMessage ?? "",
  ).trim();
  if (lastMessageAt && (!state.lastMessageAt || lastMessageAt > state.lastMessageAt)) {
    const patch: any = { last_message_at: lastMessageAt };
    if (preview) patch.last_message_preview = preview.slice(0, 120);
    const { error } = await sb.from("conversations").update(patch).eq("id", state.conversationId);
    if (error) throw error;
    state.lastMessageAt = lastMessageAt;
  }

  return { ...state, remoteJid, isGroup: group };
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

// uazapi devolve o mesmo id em dois formatos: "<jid>:<HEX>" (webhook) e
// "<HEX>" (history sync). Normalizamos para o HEX puro pra o índice único
// em messages.external_id colapsar as duas linhas.
function normalizeExternalId(id: string | undefined | null): string | null {
  if (!id) return null;
  const trimmed = String(id).trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^\d+:(.+)$/);
  return m ? m[1] : trimmed;
}

export async function ingestMessage(sb: any, channelId: string, m: any, chat?: any): Promise<boolean> {
  const key = m?.key ?? m;
  const remoteJid: string | undefined =
    key?.remoteJid ?? m?.remoteJid ?? m?.chatid ?? m?.chatId ?? m?.from ?? m?.sender ?? m?.jid;
  const fromMe: boolean = Boolean(key?.fromMe ?? m?.fromMe ?? m?.from_me);
  const externalId: string | null = normalizeExternalId(
    key?.id ?? m?.id ?? m?.messageid ?? m?.messageId ?? m?.message_id,
  );
  const pushName: string | undefined = m?.pushName ?? m?.senderName ?? m?.name ?? m?.sender_name;
  const timestamp: number | undefined = m?.messageTimestamp ?? m?.timestamp ?? m?.t;

  const group = isGroupChat(remoteJid, m);
  const phone = chatAddress(remoteJid, m);
  if (!remoteJid || !phone || remoteJid.includes("@broadcast") || remoteJid === "status@broadcast") {
    return false;
  }

  if (externalId) {
    const { data: dup } = await sb
      .from("messages")
      .select("id")
      .eq("external_id", externalId)
      .maybeSingle();
    if (dup) return false;
  }


  const caption = extractText(m);
  const media = extractMedia(m);
  const isMedia = media.type !== null;

  // Se não é mídia e não tem texto, ignora
  if (!isMedia && !caption) return false;

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

  const chatInfo = chat ?? m;
  const contactName = group
    ? chatDisplayName(chatInfo, true, phone)
    : (!fromMe && pushName ? pushName : null);
  const state = await ensureConversationBase(sb, channelId, {
    address: phone,
    remoteJid,
    name: contactName,
    avatarUrl: chatInfo?.image ?? chatInfo?.imagePreview ?? chatInfo?.PictureUrl ?? null,
    isGroup: group,
  });

  const conversationId = state.conversationId;
  const unread = state.unread;
  const lastMessageAt = state.lastMessageAt;
  let wasResolved = false;
  if (!fromMe && (state.status === "resolved" || state.status === "closed")) {
    wasResolved = true;
    const { error } = await sb
      .from("conversations")
      .update({
        status: "open",
        resolved_at: null,
        resolved_by: null,
        last_opened_at: new Date().toISOString(),
      })
      .eq("id", conversationId);
    if (error) throw error;
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
      ...(group
        ? {
            group: {
              jid: remoteJid,
              senderJid: key?.participant ?? m?.participant ?? m?.sender ?? null,
              senderName: pushName ?? null,
            },
          }
        : {}),
      ...(isMedia
        ? { media: { url: media.url, mimetype: media.mimetype, filename: media.filename } }
        : {}),
    },
  };
  if (createdAt) insertRow.created_at = createdAt;

  const { error: insertErr } = await sb.from("messages").insert(insertRow);
  if (insertErr && (insertErr as any).code !== "23505") throw insertErr;
  if (insertErr) return false;

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
  if (!group && !fromMe && !isHistorical) {
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
          shouldGreet: state.isNewConv || wasResolved,
          currentTags: state.currentTags,
          botActive: state.botActive,
          token,
        });
      }
    } catch (e) {
      console.error("[welcome-bot] erro:", (e as Error).message);
    }
  }
  return true;
}
