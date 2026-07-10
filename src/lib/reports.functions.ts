// Server function de relatórios (Fase 5 do roadmap).
// A agregação roda no Postgres via RPC com service role (migration
// 20260710120000): a tela antiga puxava todas as linhas no client, o que
// truncava em 1000 registros (limite do PostgREST) e mostrava só as conversas
// visíveis pela RLS do agente logado — números parciais sem aviso.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type ReportOverview = {
  inbound_count: number;
  outbound_count: number;
  conversations_active: number;
  conversations_new: number;
  conversations_resolved: number;
  conversations_open_now: number;
  contacts_new: number;
  avg_first_response_secs: number | null;
  avg_resolution_secs: number | null;
};

export type ReportDailyFlow = { day: string; inbound: number; outbound: number };

export type ReportAgentPerformance = {
  agent_id: string;
  agent_name: string;
  messages_sent: number;
  conversations_attended: number;
  resolved_count: number;
  avg_first_response_secs: number | null;
};

export const getReportMetrics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]) }))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // gate: qualquer agente/admin pode ver as métricas da equipe
    const { data: roles, error: rolesErr } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (rolesErr) throw new Error(rolesErr.message);
    if (!roles?.length) throw new Error("Sem permissão de atendimento.");

    const since = new Date(Date.now() - data.days * 24 * 60 * 60 * 1000).toISOString();

    const [overviewRes, dailyRes, agentsRes] = await Promise.all([
      supabaseAdmin.rpc("report_overview" as any, { _since: since }),
      supabaseAdmin.rpc("report_daily_flow" as any, { _since: since }),
      supabaseAdmin.rpc("report_agent_performance" as any, { _since: since }),
    ]);
    if (overviewRes.error) throw new Error(overviewRes.error.message);
    if (dailyRes.error) throw new Error(dailyRes.error.message);
    if (agentsRes.error) throw new Error(agentsRes.error.message);

    const overviewRow = (
      Array.isArray(overviewRes.data) ? overviewRes.data[0] : overviewRes.data
    ) as ReportOverview | undefined;

    return {
      overview: overviewRow ?? null,
      daily: (dailyRes.data ?? []) as ReportDailyFlow[],
      agents: (agentsRes.data ?? []) as ReportAgentPerformance[],
    };
  });
