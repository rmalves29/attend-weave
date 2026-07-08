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
    m?.message?.text ??
    m?.message?.conversation ??
    m?.message?.extendedTextMessage?.text ??
    m?.message?.textMessage?.text ??
    m?.msgContent?.conversation ??
    m?.msgContent?.extendedTextMessage?.text ??
    m?.textMessage?.text ??
    m?.content?.text ??
    m?.body ??
    m?.content ??
    ""
  );
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

  const content = extractText(m);
  if (!content && !m?.mediaUrl) return;

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
    type: "text",
    content: content || "[mídia]",
    external_id: externalId,
    status: "delivered",
    metadata: { raw: m },
  };
  if (createdAt) insertRow.created_at = createdAt;

  const { error: insertErr } = await sb.from("messages").insert(insertRow);
  if (insertErr && (insertErr as any).code !== "23505") throw insertErr;
  if (insertErr) return;

  await sb.from("conversations").update({
    last_message_at: createdAt ?? new Date().toISOString(),
    last_message_preview: (content || "[mídia]").slice(0, 120),
    unread_count: fromMe ? unread : unread + 1,
  }).eq("id", conversationId);
}
