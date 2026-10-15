// Server functions do painel de relatórios gerenciais.
// Agregação no Postgres via RPCs `report_*_v3` (migration 0003_reports_v3),
// executadas com service_role. Regras: grupos fora por padrão, 1ª resposta
// por turno (mesma lógica em visão geral, canais e equipe), resolução separada
// entre atendente e finalização automática.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type ReportOverviewV3 = {
  inbound_count: number;
  outbound_count: number;
  conversations_active: number;
  conversations_new: number;
  contacts_new: number;
  turns_total: number;
  turns_answered: number;
  turns_unanswered: number;
  p50_first_response_secs: number | null;
  p90_first_response_secs: number | null;
  avg_first_response_secs: number | null;
  sla_5m_count: number;
  sla_15m_count: number;
  sla_1h_count: number;
  resolved_by_agent: number;
  auto_finalized: number;
  p50_resolution_secs: number | null;
  p90_resolution_secs: number | null;
  avg_resolution_secs: number | null;
  open_now_count: number;
  oldest_open_secs: number | null;
};
// Alias para consumidores antigos.
export type ReportOverviewV2 = ReportOverviewV3;

export type ReportDailyFlow = { day: string; inbound: number; outbound: number };
export type ReportAgentV3 = {
  agent_id: string | null;
  agent_name: string;
  messages_sent: number;
  conversations_attended: number;
  turns_answered: number;
  p50_first_response_secs: number | null;
  avg_first_response_secs: number | null;
  resolved_count: number;
};
export type ReportHeatmapCell = { dow: number; hour: number; inbound: number };
export type ReportTopTag = { tag_name: string; conversations_count: number };
export type ReportChannelV3 = {
  channel_id: string;
  channel_name: string;
  channel_type: string;
  inbound_count: number;
  outbound_count: number;
  conversations_count: number;
  turns_total: number;
  turns_unanswered: number;
  p50_first_response_secs: number | null;
};
export type ReportFollowupsSummary = {
  scheduled_count: number;
  sent_count: number;
  cancelled_count: number;
  failed_count: number;
  upcoming: { id: string; send_at: string; tag_name: string | null; contact_name: string | null }[];
};

const inputSchema = z.object({
  days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  channelIds: z.array(z.string().uuid()).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  includeGroups: z.boolean().optional(),
});
type WindowInput = z.infer<typeof inputSchema>;

function windowRange(days: WindowInput["days"], untilIso?: string) {
  const until = untilIso ? new Date(untilIso) : new Date();
  const since = new Date(until.getTime() - days * 86_400_000);
  const prevSince = new Date(since.getTime() - days * 86_400_000);
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    prevSince: prevSince.toISOString(),
    prevUntil: since.toISOString(),
  };
}

async function assertRole(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("Sem permissão de atendimento.");
}

function params(data: WindowInput, since: string, until: string) {
  return {
    _since: since,
    _until: until,
    _channel_ids: data.channelIds?.length ? data.channelIds : null,
    _include_groups: !!data.includeGroups,
  };
}

export const getOverviewMetrics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v) => inputSchema.parse(v))
  .handler(async ({ data, context }) => {
    await assertRole(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const w = windowRange(data.days, data.until);
    const [curr, prev, daily] = await Promise.all([
      supabaseAdmin.rpc("report_overview_v3" as any, params(data, w.since, w.until)),
      supabaseAdmin.rpc("report_overview_v3" as any, params(data, w.prevSince, w.prevUntil)),
      supabaseAdmin.rpc("report_daily_flow_v3" as any, params(data, w.since, w.until)),
    ]);
    for (const r of [curr, prev, daily]) if (r.error) throw new Error(r.error.message);
    return {
      overview: (curr.data ?? null) as ReportOverviewV3 | null,
      previous: (prev.data ?? null) as ReportOverviewV3 | null,
      daily: (daily.data ?? []) as ReportDailyFlow[],
    };
  });

export const getSlaMetrics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v) => inputSchema.parse(v))
  .handler(async ({ data, context }) => {
    await assertRole(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const w = windowRange(data.days, data.until);
    const [ov, hm] = await Promise.all([
      supabaseAdmin.rpc("report_overview_v3" as any, params(data, w.since, w.until)),
      supabaseAdmin.rpc("report_hourly_heatmap_v3" as any, params(data, w.since, w.until)),
    ]);
    if (ov.error) throw new Error(ov.error.message);
    if (hm.error) throw new Error(hm.error.message);
    return {
      overview: (ov.data ?? null) as ReportOverviewV3 | null,
      heatmap: (hm.data ?? []) as ReportHeatmapCell[],
    };
  });

export const getTeamMetrics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v) => inputSchema.parse(v))
  .handler(async ({ data, context }) => {
    await assertRole(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const w = windowRange(data.days, data.until);
    const { data: rows, error } = await supabaseAdmin.rpc(
      "report_agent_performance_v3" as any,
      params(data, w.since, w.until),
    );
    if (error) throw new Error(error.message);
    return { agents: (rows ?? []) as ReportAgentV3[] };
  });

export const getTopicsMetrics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v) => inputSchema.parse(v))
  .handler(async ({ data, context }) => {
    await assertRole(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const w = windowRange(data.days, data.until);
    const channels = data.channelIds?.length ? data.channelIds : null;
    const [tags, ch, fu, tagCount, taggedConvs] = await Promise.all([
      supabaseAdmin.rpc("report_top_tags" as any, {
        _since: w.since, _until: w.until, _limit: 10, _channel_ids: channels,
      }),
      supabaseAdmin.rpc("report_channel_breakdown_v3" as any, params(data, w.since, w.until)),
      supabaseAdmin.rpc("report_followups_summary" as any, { _since: w.since, _until: w.until }),
      supabaseAdmin.from("tags").select("id", { count: "exact", head: true }),
      supabaseAdmin.from("conversations").select("id", { count: "exact", head: true }).neq("tags", "{}"),
    ]);
    if (tags.error) throw new Error(tags.error.message);
    if (ch.error) throw new Error(ch.error.message);
    if (fu.error) throw new Error(fu.error.message);
    const fuRow =
      ((Array.isArray(fu.data) ? fu.data[0] : fu.data) as ReportFollowupsSummary | undefined) ?? {
        scheduled_count: 0, sent_count: 0, cancelled_count: 0, failed_count: 0, upcoming: [],
      };
    return {
      topTags: (tags.data ?? []) as ReportTopTag[],
      channels: (ch.data ?? []) as ReportChannelV3[],
      followups: fuRow,
      tagsRegistered: tagCount.count ?? 0,
      conversationsWithTags: taggedConvs.count ?? 0,
    };
  });

export const getChannelsForFilter = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertRole(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.from("channels").select("id, name, type").order("name");
    if (error) throw new Error(error.message);
    return (data ?? []) as { id: string; name: string; type: string }[];
  });

export const getReportMetrics = getOverviewMetrics;
