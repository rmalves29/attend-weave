// Envio de texto via uazapi, compartilhado entre a server fn de chat
// (sendUazapiMessage) e o dispatcher de mensagens agendadas — a lógica de
// resolver telefone/token, persistir no banco e atualizar preview da
// conversa não deve ser duplicada entre os dois callers.
import { uazapiFetch, resolveReply } from "./uazapi.functions";

export async function sendTextViaUazapi(
  supabaseAdmin: any,
  params: {
    conversationId: string;
    text: string;
    senderAgentId: string | null;
    replyToMessageId?: string;
    // Humanização — usado SÓ pelo disparo em massa (campanhas). No atendimento
    // normal vem undefined, então nada muda. `delayMs` faz a própria uazapi
    // mostrar "digitando..." por esse tempo antes de soltar a mensagem.
    delayMs?: number;
  },
) {
  const { data: conv, error: convErr } = await supabaseAdmin
    .from("conversations")
    .select("id, channel_id, contact_id, assigned_agent_id, contacts(phone), channels(credentials)")
    .eq("id", params.conversationId)
    .single();
  if (convErr || !conv) throw new Error("Conversa não encontrada");

  const phone = (conv as any).contacts?.phone as string | null;
  if (!phone) throw new Error("Contato sem telefone");
  const token = ((conv as any).channels?.credentials as any)?.token;
  if (!token) throw new Error("Canal sem token uazapi");

  const reply = await resolveReply(supabaseAdmin, params.replyToMessageId);

  const body: any = { number: phone, text: params.text, replyid: reply?.shortId };
  if (params.delayMs && params.delayMs > 0) body.delay = Math.round(params.delayMs);
  const res = await uazapiFetch("/send/text", { token, body });
  const rawExternalId: string | null =
    res?.messageid ?? res?.id ?? res?.key?.id ?? res?.message?.key?.id ?? null;
  // Normaliza pra bater com o que o webhook/sync vão gravar depois
  const externalId: string | null = rawExternalId
    ? (String(rawExternalId).match(/^\d+:(.+)$/)?.[1] ?? String(rawExternalId))
    : null;

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("messages")
    .insert({
      conversation_id: conv.id,
      sender_agent_id: params.senderAgentId,
      direction: "outbound",
      type: "text",
      content: params.text,
      status: "sent",
      external_id: externalId,
      metadata: { uazapi: res, ...(reply ? { replyTo: reply.preview } : {}) },
    })
    .select("id")
    .single();
  if (insErr && (insErr as any).code !== "23505") throw insErr;

  const convPatch: any = {
    assigned_agent_id: conv.assigned_agent_id ?? params.senderAgentId,
    last_message_at: new Date().toISOString(),
    last_message_preview: params.text.slice(0, 120),
  };
  // Atendente/admin respondeu → tira BOOT e status vira ABERTO (bot silencia).
  if (params.senderAgentId) {
    convPatch.bot_active = false;
    const { data: convTags } = await supabaseAdmin
      .from("conversations").select("tags").eq("id", conv.id).single();
    convPatch.tags = (convTags?.tags ?? []).filter((t: string) => t.toLowerCase() !== "boot");
    convPatch.status = "open";
  }
  await supabaseAdmin
    .from("conversations")
    .update(convPatch)
    .eq("id", conv.id);

  return { ok: true as const, externalId, messageId: inserted?.id as string | undefined };
}

// Envio de mídia (imagem/vídeo/áudio/documento) via uazapi — usado pelo disparo
// em massa (campanhas) e reaproveitável. Gera uma signed URL do bucket a cada
// envio, persiste a mensagem e atualiza a conversa. `delayMs` = "digitando…".
export async function sendMediaViaUazapi(
  supabaseAdmin: any,
  params: {
    conversationId: string;
    storagePath: string;
    filename: string;
    mimeType: string;
    caption?: string;
    senderAgentId: string | null;
    delayMs?: number;
  },
) {
  const { data: conv, error: convErr } = await supabaseAdmin
    .from("conversations")
    .select("id, assigned_agent_id, contacts(phone), channels(credentials)")
    .eq("id", params.conversationId)
    .single();
  if (convErr || !conv) throw new Error("Conversa não encontrada");

  const phone = (conv as any).contacts?.phone as string | null;
  if (!phone) throw new Error("Contato sem telefone");
  const token = ((conv as any).channels?.credentials as any)?.token;
  if (!token) throw new Error("Canal sem token uazapi");

  const { data: signed, error: signErr } = await supabaseAdmin
    .storage.from("attachments")
    .createSignedUrl(params.storagePath, 60 * 60);
  if (signErr || !signed?.signedUrl) throw new Error("Falha ao gerar URL do arquivo");

  const mime = params.mimeType;
  const kind =
    mime.startsWith("image/") ? "image" :
    mime.startsWith("video/") ? "video" :
    mime.startsWith("audio/") ? "audio" :
    "document";

  const body: any = {
    number: phone,
    type: kind,
    file: signed.signedUrl,
    docName: kind === "document" ? params.filename : undefined,
    text: params.caption ?? "",
  };
  if (params.delayMs && params.delayMs > 0) body.delay = Math.round(params.delayMs);

  const res = await uazapiFetch("/send/media", { token, body });
  const rawExternalId: string | null =
    res?.messageid ?? res?.id ?? res?.key?.id ?? res?.message?.key?.id ?? null;
  const externalId: string | null = rawExternalId
    ? (String(rawExternalId).match(/^\d+:(.+)$/)?.[1] ?? String(rawExternalId))
    : null;

  const contentPreview = params.caption?.trim() || `[${kind}] ${params.filename}`;

  const { data: inserted, error: insErr } = await supabaseAdmin.from("messages").insert({
    conversation_id: conv.id,
    sender_agent_id: params.senderAgentId,
    direction: "outbound",
    type: kind,
    content: contentPreview,
    status: "sent",
    external_id: externalId,
    metadata: {
      uazapi: res,
      media: { storagePath: params.storagePath, filename: params.filename, mimeType: mime },
    },
  }).select("id").single();
  if (insErr && (insErr as any).code !== "23505") throw insErr;

  await supabaseAdmin.from("conversations").update({
    assigned_agent_id: (conv as any).assigned_agent_id ?? params.senderAgentId,
    last_message_at: new Date().toISOString(),
    last_message_preview: contentPreview.slice(0, 120),
  }).eq("id", conv.id);

  return { ok: true as const, externalId, messageId: inserted?.id as string | undefined };
}
