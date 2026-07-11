// Server functions do painel de relatórios gerenciais.
// Toda a agregação acontece no Postgres via RPCs `report_*_v2` (migration
// 20260710021226) executadas com service_role. As funções aqui apenas
// autorizam o chamador (qualquer usuário com role em user_roles) e serializam
// os parâmetros de janela + filtro por canal.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// ---------- Tipos compartilhados ----------

export type ReportOverviewV2 = {
  inbound_count: number;
  outbound_count: number;
  conversations_active: number;
  conversations_new: number;
  conversations_resolved: number;
  conversations_open_now: number;
  oldest_open_secs: number | null;
  contacts_new: number;
  avg_first_response_secs: number | null;
  avg_resolution_secs: number | null;
  p50_first_response_secs: number | null;
  p90_first_response_secs: number | null;
  p95_first_response_secs: number | null;
  p50_resolution_secs: number | null;
  p90_resolution_secs: number | null;
  p95_resolution_secs: number | null;
  sla_5m_count: number;
  sla_15m_count: number;
  sla_1h_count: number;
  sla_total_count: number;
};

export type ReportDailyFlow = { day: string; inbound: number; outbound: number };

export type ReportAgentPerformanceV2 = {
  agent_id: string;
  agent_name: string;
  messages_sent: number;
  conversations_attended: number;
  resolved_count: number;
  avg_first_response_secs: number | null;
  aht_secs: number | null;
  first_contact_resolution_count: number;
  concurrent_avg: number;
  concurrent_peak: number;
};

export type ReportHeatmapCell = { dow: number; hour: number; inbound: number };
export type ReportTopTag = { tag_name: string; conversations_count: number };
export type ReportChannelBreakdown = {
  channel_id: string;
  channel_name: string;
  channel_type: string;
  inbound_count: number;
  outbound_count: number;
  conversations_count: number;
  avg_first_response_secs: number | null;
};
export type ReportFollowupsUpcoming = {
  id: string;
  send_at: string;
  tag_name: string | null;
  contact_name: string | null;
};
export type ReportFollowupsSummary = {
  scheduled_count: number;
  sent_count: number;
  cancelled_count: number;
  failed_count: number;
  upcoming: ReportFollowupsUpcoming[];
};

// ---------- Helpers ----------

const inputSchema = z.object({
  days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  channelIds: z.array(z.string().uuid()).optional(),
  // `until` compartilhado pela página: sem ele cada aba fixava o "agora" no
  // momento da própria requisição, fazendo os totais divergirem entre abas.
  until: z.string().datetime({ offset: true }).optional(),
});

type WindowInput = z.infer<typeof inputSchema>;

function windowRange(days: WindowInput["days"], untilIso?: string) {
  const until = untilIso ? new Date(untilIso) : new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  const prevUntil = since;
  const prevSince = new Date(since.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    prevSince: prevSince.toISOString(),
    prevUntil: prevUntil.toISOString(),
  };
}

async function assertRole(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("Sem permissão de atendimento.");
}

// ---------- 1. Visão geral (com comparativo) ----------

export const getOverviewMetrics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v) => inputSchema.parse(v))
  .handler(async ({ data, context }) => {
    await assertRole(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { since, until, prevSince, prevUntil } = windowRange(data.days, data.until);
    const channels = data.channelIds?.length ? data.channelIds : null;

    const [curr, prev, daily] = await Promise.all([
      supabaseAdmin.rpc("report_overview_v2" as any, {
        _since: since,
        _until: until,
        _channel_ids: channels,
      }),
      supabaseAdmin.rpc("report_overview_v2" as any, {
        _since: prevSince,
        _until: prevUntil,
        _channel_ids: channels,
      }),
      supabaseAdmin.rpc("report_daily_flow_v2" as any, {
        _since: since,
        _until: until,
        _channel_ids: channels,
      }),
    ]);
    if (curr.error) throw new Error(curr.error.message);
    if (prev.error) throw new Error(prev.error.message);
    if (daily.error) throw new Error(daily.error.message);

    const pick = (r: any): ReportOverviewV2 | null =>
      (Array.isArray(r.data) ? r.data[0] : r.data) ?? null;

    return {
      overview: pick(curr),
      previous: pick(prev),
      daily: (daily.data ?? []) as ReportDailyFlow[],
    };
  });

// ---------- 2. SLA (usa mesma RPC de overview + heatmap) ----------

export const getSlaMetrics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v) => inputSchema.parse(v))
  .handler(async ({ data, context }) => {
    await assertRole(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { since, until } = windowRange(data.days, data.until);
    const channels = data.channelIds?.length ? data.channelIds : null;

    const [ov, hm] = await Promise.all([
      supabaseAdmin.rpc("report_overview_v2" as any, {
        _since: since,
        _until: until,
        _channel_ids: channels,
      }),
      supabaseAdmin.rpc("report_hourly_heatmap" as any, {
        _since: since,
        _until: until,
        _channel_ids: channels,
      }),
    ]);
    if (ov.error) throw new Error(ov.error.message);
    if (hm.error) throw new Error(hm.error.message);

    const overview =
      ((Array.isArray(ov.data) ? ov.data[0] : ov.data) as ReportOverviewV2 | undefined) ?? null;
    return {
      overview,
      heatmap: (hm.data ?? []) as ReportHeatmapCell[],
    };
  });

// ---------- 3. Equipe ----------

export const getTeamMetrics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v) => inputSchema.parse(v))
  .handler(async ({ data, context }) => {
    await assertRole(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { since, until } = windowRange(data.days, data.until);
    const channels = data.channelIds?.length ? data.channelIds : null;

    const { data: rows, error } = await supabaseAdmin.rpc(
      "report_agent_performance_v2" as any,
      { _since: since, _until: until, _channel_ids: channels },
    );
    if (error) throw new Error(error.message);
    return { agents: (rows ?? []) as ReportAgentPerformanceV2[] };
  });

// ---------- 4. Assuntos e canais ----------

export const getTopicsMetrics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v) => inputSchema.parse(v))
  .handler(async ({ data, context }) => {
    await assertRole(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { since, until } = windowRange(data.days, data.until);
    const channels = data.channelIds?.length ? data.channelIds : null;

    const [tags, ch, fu] = await Promise.all([
      supabaseAdmin.rpc("report_top_tags" as any, {
        _since: since,
        _until: until,
        _limit: 10,
        _channel_ids: channels,
      }),
      supabaseAdmin.rpc("report_channel_breakdown" as any, { _since: since, _until: until }),
      supabaseAdmin.rpc("report_followups_summary" as any, { _since: since, _until: until }),
    ]);
    if (tags.error) throw new Error(tags.error.message);
    if (ch.error) throw new Error(ch.error.message);
    if (fu.error) throw new Error(fu.error.message);

    const fuRow =
      ((Array.isArray(fu.data) ? fu.data[0] : fu.data) as ReportFollowupsSummary | undefined) ?? {
        scheduled_count: 0,
        sent_count: 0,
        cancelled_count: 0,
        failed_count: 0,
        upcoming: [],
      };

    return {
      topTags: (tags.data ?? []) as ReportTopTag[],
      channels: (ch.data ?? []) as ReportChannelBreakdown[],
      followups: fuRow,
    };
  });

// ---------- 5. Lista de canais para o filtro ----------

export const getChannelsForFilter = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertRole(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("channels")
      .select("id, name, type")
      .order("name");
    if (error) throw new Error(error.message);
    return (data ?? []) as { id: string; name: string; type: string }[];
  });

// ---------- Compatibilidade com código antigo ----------
// (mantido caso algum consumidor externo importe getReportMetrics)
export const getReportMetrics = getOverviewMetrics;
