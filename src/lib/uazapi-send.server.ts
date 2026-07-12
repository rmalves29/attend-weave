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

  const res = await uazapiFetch("/send/text", {
    token,
    body: { number: phone, text: params.text, replyid: reply?.shortId },
  });
  const externalId: string | null =
    res?.messageid ?? res?.id ?? res?.key?.id ?? res?.message?.key?.id ?? null;

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
