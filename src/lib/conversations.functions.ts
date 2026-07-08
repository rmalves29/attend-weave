// Server functions de gestão de conversas (Fase 1 do roadmap):
// transferir entre atendentes, mudar status e editar tags.
// Rodam com service role (as policies RLS de UPDATE só permitem o próprio
// agente atribuído; transferência exige escrever assigned_agent_id de OUTRO
// usuário) — a autorização é validada aqui explicitamente.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function getAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function assertAgentOrAdmin(userId: string) {
  const supabaseAdmin = await getAdmin();
  const { data, error } = await supabaseAdmin
    .from("user_roles").select("role").eq("user_id", userId);
  if (error) throw new Error(error.message);
  const roles = (data ?? []).map((r: any) => r.role);
  if (!roles.includes("agent") && !roles.includes("admin")) {
    throw new Error("Sem permissão de atendimento.");
  }
  return { supabaseAdmin, isAdmin: roles.includes("admin") };
}

// Quem pode mexer na conversa: admin sempre; agente se for o atribuído ou se
// a conversa estiver sem dono.
async function loadConversationForAction(supabaseAdmin: any, conversationId: string, userId: string, isAdmin: boolean) {
  const { data: conv, error } = await supabaseAdmin
    .from("conversations").select("id, assigned_agent_id, status, tags")
    .eq("id", conversationId).single();
  if (error || !conv) throw new Error("Conversa não encontrada");
  if (!isAdmin && conv.assigned_agent_id && conv.assigned_agent_id !== userId) {
    throw new Error("Conversa atribuída a outro atendente.");
  }
  return conv;
}

export const transferConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    conversationId: z.string().uuid(),
    toAgentId: z.string().uuid(),
  }))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin, isAdmin } = await assertAgentOrAdmin(context.userId);
    await loadConversationForAction(supabaseAdmin, data.conversationId, context.userId, isAdmin);

    // destino precisa ser agente/admin ativo
    const { data: targetRoles } = await supabaseAdmin
      .from("user_roles").select("role").eq("user_id", data.toAgentId);
    if (!targetRoles?.length) throw new Error("Destinatário não é um atendente.");

    const { error } = await supabaseAdmin
      .from("conversations")
      .update({ assigned_agent_id: data.toAgentId, status: "open" })
      .eq("id", data.conversationId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setConversationStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    conversationId: z.string().uuid(),
    status: z.enum(["open", "pending", "resolved", "closed"]),
  }))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin, isAdmin } = await assertAgentOrAdmin(context.userId);
    const conv = await loadConversationForAction(supabaseAdmin, data.conversationId, context.userId, isAdmin);

    const patch: any = { status: data.status };
    // resolver zera não-lidas; assumir a conversa ao agir nela
    if (data.status === "resolved" || data.status === "closed") patch.unread_count = 0;
    if (!conv.assigned_agent_id) patch.assigned_agent_id = context.userId;

    const { error } = await supabaseAdmin
      .from("conversations").update(patch).eq("id", data.conversationId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const updateConversationTags = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    conversationId: z.string().uuid(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20),
  }))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin, isAdmin } = await assertAgentOrAdmin(context.userId);
    await loadConversationForAction(supabaseAdmin, data.conversationId, context.userId, isAdmin);

    const tags = Array.from(new Set(data.tags.map((t) => t.toLowerCase())));
    const { error } = await supabaseAdmin
      .from("conversations").update({ tags }).eq("id", data.conversationId);
    if (error) throw new Error(error.message);
    return { ok: true, tags };
  });

// Nota interna: mensagem que NUNCA vai pro WhatsApp — só a equipe vê.
export const addInternalNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    conversationId: z.string().uuid(),
    content: z.string().trim().min(1).max(2000),
  }))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await assertAgentOrAdmin(context.userId);

    const { error } = await supabaseAdmin.from("messages").insert({
      conversation_id: data.conversationId,
      sender_agent_id: context.userId,
      direction: "outbound",
      type: "text",
      content: data.content,
      status: "sent",
      is_internal: true,
    } as any);
    if (error) throw new Error(error.message);
    // não atualiza preview/last_message_at — nota não é mensagem pro cliente
    return { ok: true };
  });
