// Server functions de mensagens agendadas (Fase 2 do roadmap):
// agendar, listar e cancelar. O envio em si é feito pela rota pública
// /api/public/dispatch-scheduled-messages, chamada pelo pg_cron.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAgentOrAdmin(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  const roles = (data ?? []).map((r: any) => r.role);
  if (!roles.includes("agent") && !roles.includes("admin")) {
    throw new Error("Sem permissão de atendimento.");
  }
  return { supabaseAdmin, isAdmin: roles.includes("admin") };
}

export const scheduleMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      conversationId: z.string().uuid(),
      content: z.string().trim().min(1).max(4000),
      sendAt: z.string().datetime({ offset: true }),
    }),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await assertAgentOrAdmin(context.userId);
    // RLS: só agenda em conversa que o usuário enxerga.
    const { data: visible } = await context.supabase
      .from("conversations").select("id").eq("id", data.conversationId).maybeSingle();
    if (!visible) throw new Error("Conversa não encontrada ou sem permissão.");

    const sendAt = new Date(data.sendAt);
    if (sendAt.getTime() <= Date.now()) {
      throw new Error("A data/hora deve ser no futuro.");
    }

    const { data: row, error } = await supabaseAdmin
      .from("scheduled_messages" as any)
      .insert({
        conversation_id: data.conversationId,
        created_by: context.userId,
        content: data.content,
        send_at: sendAt.toISOString(),
      } as any)
      .select("id, content, send_at, status")
      .single();
    if (error) throw new Error(error.message);
    return { ok: true, scheduled: row };
  });

export const listScheduledMessages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ conversationId: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await assertAgentOrAdmin(context.userId);
    const { data: visible } = await context.supabase
      .from("conversations").select("id").eq("id", data.conversationId).maybeSingle();
    if (!visible) throw new Error("Conversa não encontrada ou sem permissão.");
    const { data: rows, error } = await supabaseAdmin
      .from("scheduled_messages" as any)
      .select("id, content, send_at, status, error, created_by")
      .eq("conversation_id", data.conversationId)
      .eq("status", "pending")
      .order("send_at", { ascending: true });
    if (error) throw new Error(error.message);
    return (rows ?? []) as unknown as Array<{
      id: string;
      content: string;
      send_at: string;
      status: string;
      error: string | null;
      created_by: string | null;
    }>;
  });

export const cancelScheduledMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin, isAdmin } = await assertAgentOrAdmin(context.userId);

    const { data: existing, error: findErr } = await supabaseAdmin
      .from("scheduled_messages" as any)
      .select("id, created_by, status")
      .eq("id", data.id)
      .maybeSingle();
    if (findErr) throw new Error(findErr.message);
    if (!existing) throw new Error("Agendamento não encontrado");
    if (!isAdmin && (existing as any).created_by !== context.userId) {
      throw new Error("Você só pode cancelar agendamentos criados por você.");
    }

    const { error } = await supabaseAdmin
      .from("scheduled_messages" as any)
      .update({ status: "canceled" })
      .eq("id", data.id)
      .eq("status", "pending");
    if (error) throw new Error(error.message);
    return { ok: true };
  });
