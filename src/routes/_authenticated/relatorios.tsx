import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getOverviewMetrics,
  getSlaMetrics,
  getTeamMetrics,
  getTopicsMetrics,
  getChannelsForFilter,
  type ReportOverviewV2,
} from "@/lib/reports.functions";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import {
  MessageSquare, Users, Clock, CheckCircle2, TrendingUp, TrendingDown,
  Timer, Inbox, Send, AlertTriangle, Radio, Filter, Tag as TagIcon,
  CalendarClock, ArrowUpRight, ArrowDownRight, Minus,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, CartesianGrid, Legend,
} from "recharts";

export const Route = createFileRoute("/_authenticated/relatorios")({
  head: () => ({ meta: [{ title: "Relatórios — AttendFlow" }] }),
  component: RelatoriosPage,
});

const PERIODS = [
  { days: 7 as const, label: "7 dias" },
  { days: 30 as const, label: "30 dias" },
  { days: 90 as const, label: "90 dias" },
];

const COLOR_IN = "oklch(0.65 0.15 220)";
const COLOR_OUT = "oklch(0.52 0.13 162)";
const DOWS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function formatDuration(secs: number | null | undefined): string {
  if (secs == null) return "—";
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}min`;
  if (secs < 86400) {
    const h = Math.floor(secs / 3600);
    const m = Math.round((secs % 3600) / 60);
    return m ? `${h}h ${m}min` : `${h}h`;
  }
  const d = Math.floor(secs / 86400);
  const h = Math.round((secs % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}

function pct(n: number, d: number): string {
  if (!d) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

// Δ% vs período anterior. inverted=true quando "menor é melhor" (tempos).
function DeltaBadge({
  current, previous, inverted = false,
}: { current: number | null | undefined; previous: number | null | undefined; inverted?: boolean }) {
  if (current == null || previous == null || previous === 0) {
    return <span className="text-[11px] text-muted-foreground">—</span>;
  }
  const delta = ((current - previous) / previous) * 100;
  const abs = Math.abs(delta);
  if (abs < 0.5) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground">
        <Minus className="w-3 h-3" /> 0%
      </span>
    );
  }
  const isPositiveDirection = inverted ? delta < 0 : delta > 0;
  const color = isPositiveDirection ? "text-emerald-400" : "text-rose-400";
  const Icon = delta > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-medium ${color}`}>
      <Icon className="w-3 h-3" />
      {abs.toFixed(abs < 10 ? 1 : 0)}%
    </span>
  );
}

// ============================================================================
// Página
// ============================================================================
function RelatoriosPage() {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [tab, setTab] = useState("overview");

  const channelsFn = useServerFn(getChannelsForFilter);
  const { data: channelList } = useQuery({
    queryKey: ["report-channels"],
    queryFn: () => channelsFn(),
    staleTime: 5 * 60_000,
  });

  return (
    <div className="h-full overflow-y-auto p-6 max-w-7xl mx-auto">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Relatórios</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Visão gerencial do atendimento — SLA, produtividade e assuntos.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ChannelFilter
            channels={channelList ?? []}
            selected={channelIds}
            onChange={setChannelIds}
          />
          <div className="flex gap-1 text-xs">
            {PERIODS.map((p) => (
              <button
                key={p.days}
                onClick={() => setDays(p.days)}
                className={`px-3 py-1.5 rounded-full transition-colors ${
                  days === p.days
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-accent"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="overview">Visão geral</TabsTrigger>
          <TabsTrigger value="sla">SLA &amp; tempos</TabsTrigger>
          <TabsTrigger value="team">Equipe</TabsTrigger>
          <TabsTrigger value="topics">Assuntos &amp; canais</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab days={days} channelIds={channelIds} />
        </TabsContent>
        <TabsContent value="sla">
          <SlaTab days={days} channelIds={channelIds} />
        </TabsContent>
        <TabsContent value="team">
          <TeamTab days={days} channelIds={channelIds} />
        </TabsContent>
        <TabsContent value="topics">
          <TopicsTab days={days} channelIds={channelIds} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============================================================================
// Filtro de canais (multi-select)
// ============================================================================
function ChannelFilter({
  channels, selected, onChange,
}: {
  channels: { id: string; name: string; type: string }[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const label =
    selected.length === 0
      ? "Todos os canais"
      : selected.length === 1
        ? channels.find((c) => c.id === selected[0])?.name ?? "1 canal"
        : `${selected.length} canais`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 text-xs">
          <Filter className="w-3.5 h-3.5 mr-1.5" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <div className="text-xs text-muted-foreground px-2 py-1.5">Filtrar por canal</div>
        {channels.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">Nenhum canal.</div>
        ) : (
          <div className="max-h-64 overflow-y-auto">
            {channels.map((c) => {
              const checked = selected.includes(c.id);
              return (
                <label
                  key={c.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent cursor-pointer"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(v) => {
                      onChange(
                        v ? [...selected, c.id] : selected.filter((id) => id !== c.id),
                      );
                    }}
                  />
                  <span className="text-sm truncate flex-1">{c.name}</span>
                  <span className="text-[10px] uppercase text-muted-foreground">{c.type}</span>
                </label>
              );
            })}
          </div>
        )}
        {selected.length > 0 && (
          <Button
            variant="ghost" size="sm"
            className="w-full mt-1 text-xs h-7"
            onClick={() => onChange([])}
          >
            Limpar
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ============================================================================
// Tab 1 — Visão geral
// ============================================================================
function OverviewTab({ days, channelIds }: { days: 7 | 30 | 90; channelIds: string[] }) {
  const fn = useServerFn(getOverviewMetrics);
  const { data, isLoading, error } = useQuery({
    queryKey: ["report-overview", days, channelIds],
    queryFn: () => fn({ data: { days, channelIds } }),
    staleTime: 60_000,
  });

  if (error) return <ErrorCard message={(error as Error).message} />;

  const ov = data?.overview;
  const prev = data?.previous;
  const daily = (data?.daily ?? []).map((d) => ({
    date: d.day.slice(5),
    recebidas: d.inbound,
    enviadas: d.outbound,
  }));

  const kpis: Array<{
    label: string;
    value: number | string;
    curr: number | null | undefined;
    prev: number | null | undefined;
    icon: any;
    color: string;
    inverted?: boolean;
  }> = [
    { label: "Recebidas", value: ov?.inbound_count ?? 0, curr: ov?.inbound_count, prev: prev?.inbound_count, icon: Inbox, color: "text-chart-2" },
    { label: "Enviadas", value: ov?.outbound_count ?? 0, curr: ov?.outbound_count, prev: prev?.outbound_count, icon: Send, color: "text-primary" },
    { label: "Conversas atendidas", value: ov?.conversations_active ?? 0, curr: ov?.conversations_active, prev: prev?.conversations_active, icon: MessageSquare, color: "text-chart-3" },
    { label: "Resolvidas", value: ov?.conversations_resolved ?? 0, curr: ov?.conversations_resolved, prev: prev?.conversations_resolved, icon: CheckCircle2, color: "text-primary" },
    { label: "Em aberto agora", value: ov?.conversations_open_now ?? 0, curr: ov?.conversations_open_now, prev: prev?.conversations_open_now, icon: Clock, color: "text-chart-4", inverted: true },
    { label: "Contatos novos", value: ov?.contacts_new ?? 0, curr: ov?.contacts_new, prev: prev?.contacts_new, icon: Users, color: "text-chart-5" },
    { label: "1ª resposta (média)", value: formatDuration(ov?.avg_first_response_secs), curr: ov?.avg_first_response_secs, prev: prev?.avg_first_response_secs, icon: Timer, color: "text-chart-2", inverted: true },
    { label: "Resolução (média)", value: formatDuration(ov?.avg_resolution_secs), curr: ov?.avg_resolution_secs, prev: prev?.avg_resolution_secs, icon: TrendingUp, color: "text-chart-3", inverted: true },
  ];

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {kpis.map((k) => (
          <Card key={k.label} className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{k.label}</span>
              <k.icon className={`w-4 h-4 ${k.color}`} />
            </div>
            <div className="text-2xl font-bold mt-2">{isLoading ? "…" : k.value}</div>
            <div className="mt-1">
              <DeltaBadge current={k.curr} previous={k.prev} inverted={k.inverted} />
              <span className="text-[10px] text-muted-foreground ml-1">vs. período anterior</span>
            </div>
          </Card>
        ))}
      </div>

      <Card className="p-4">
        <h3 className="font-semibold mb-4">Fluxo de mensagens por dia</h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.32 0.012 200)" />
              <XAxis dataKey="date" stroke="oklch(0.68 0.012 200)" tick={{ fontSize: 11 }} />
              <YAxis stroke="oklch(0.68 0.012 200)" tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip contentStyle={{ background: "oklch(0.25 0.012 200)", border: "1px solid oklch(0.32 0.012 200)", borderRadius: 8 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="recebidas" stroke={COLOR_IN} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="enviadas" stroke={COLOR_OUT} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </>
  );
}

// ============================================================================
// Tab 2 — SLA
// ============================================================================
function SlaTab({ days, channelIds }: { days: 7 | 30 | 90; channelIds: string[] }) {
  const fn = useServerFn(getSlaMetrics);
  const { data, isLoading, error } = useQuery({
    queryKey: ["report-sla", days, channelIds],
    queryFn: () => fn({ data: { days, channelIds } }),
    staleTime: 60_000,
  });

  if (error) return <ErrorCard message={(error as Error).message} />;
  const ov = data?.overview ?? null;
  const total = ov?.sla_total_count ?? 0;

  // Fila em aberto — cor conforme idade da mais antiga
  const oldestSecs = ov?.oldest_open_secs ?? null;
  const queueTone =
    oldestSecs == null
      ? "text-muted-foreground"
      : oldestSecs > 3600
        ? "text-rose-400"
        : oldestSecs > 900
          ? "text-amber-400"
          : "text-emerald-400";

  const slaBuckets = [
    { label: "≤ 5 min", value: ov?.sla_5m_count ?? 0, tone: "bg-emerald-500" },
    { label: "≤ 15 min", value: (ov?.sla_15m_count ?? 0) - (ov?.sla_5m_count ?? 0), tone: "bg-sky-500" },
    { label: "≤ 1 h", value: (ov?.sla_1h_count ?? 0) - (ov?.sla_15m_count ?? 0), tone: "bg-amber-500" },
    { label: "> 1 h", value: total - (ov?.sla_1h_count ?? 0), tone: "bg-rose-500" },
  ];

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        <Card className="p-4 md:col-span-1">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Fila em aberto agora</span>
            <AlertTriangle className={`w-4 h-4 ${queueTone}`} />
          </div>
          <div className="text-3xl font-bold mt-2">
            {isLoading ? "…" : ov?.conversations_open_now ?? 0}
          </div>
          <div className={`text-xs mt-1 ${queueTone}`}>
            {oldestSecs == null ? "Nenhuma pendente" : `Mais antiga: ${formatDuration(oldestSecs)}`}
          </div>
        </Card>

        <Card className="p-4 md:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-muted-foreground">
              Distribuição do tempo até 1ª resposta
            </span>
            <span className="text-[11px] text-muted-foreground">{total} conversas</span>
          </div>
          {total === 0 ? (
            <p className="text-xs text-muted-foreground py-4">Sem dados no período.</p>
          ) : (
            <>
              <div className="flex h-3 rounded-full overflow-hidden bg-muted">
                {slaBuckets.map((b) => (
                  <div
                    key={b.label}
                    className={b.tone}
                    style={{ width: `${(b.value / total) * 100}%` }}
                    title={`${b.label}: ${b.value} (${pct(b.value, total)})`}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-[11px]">
                {slaBuckets.map((b) => (
                  <div key={b.label} className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${b.tone}`} />
                    <span className="text-muted-foreground">{b.label}</span>
                    <span className="font-medium">
                      {b.value} ({pct(b.value, total)})
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card className="p-4">
          <h3 className="font-semibold mb-3">Percentis — tempo até 1ª resposta</h3>
          <PercentileTable
            p50={ov?.p50_first_response_secs}
            p90={ov?.p90_first_response_secs}
            p95={ov?.p95_first_response_secs}
            avg={ov?.avg_first_response_secs}
          />
          <p className="text-[11px] text-muted-foreground mt-3">
            p90 = 90% das respostas ficam abaixo desse tempo. Ajuda a enxergar o pior caso
            que média esconde.
          </p>
        </Card>
        <Card className="p-4">
          <h3 className="font-semibold mb-3">Percentis — tempo até resolução</h3>
          <PercentileTable
            p50={ov?.p50_resolution_secs}
            p90={ov?.p90_resolution_secs}
            p95={ov?.p95_resolution_secs}
            avg={ov?.avg_resolution_secs}
          />
        </Card>
      </div>

      <Card className="p-4">
        <h3 className="font-semibold mb-3">Volume por hora — dias da semana</h3>
        <Heatmap cells={data?.heatmap ?? []} />
        <p className="text-[11px] text-muted-foreground mt-3">
          Baseado em mensagens recebidas (horário Brasília). Bom para dimensionar escala.
        </p>
      </Card>
    </>
  );
}

function PercentileTable({
  p50, p90, p95, avg,
}: { p50?: number | null; p90?: number | null; p95?: number | null; avg?: number | null }) {
  const rows = [
    { l: "Média", v: avg },
    { l: "p50 (mediana)", v: p50 },
    { l: "p90", v: p90 },
    { l: "p95 (pior caso)", v: p95 },
  ];
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map((r) => (
          <tr key={r.l} className="border-b border-border/50 last:border-0">
            <td className="py-2 text-muted-foreground">{r.l}</td>
            <td className="py-2 text-right font-medium">{formatDuration(r.v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Heatmap({ cells }: { cells: { dow: number; hour: number; inbound: number }[] }) {
  const map = new Map<string, number>();
  let max = 0;
  for (const c of cells) {
    map.set(`${c.dow}-${c.hour}`, c.inbound);
    if (c.inbound > max) max = c.inbound;
  }
  return (
    <div className="overflow-x-auto">
      <div className="inline-block min-w-full">
        <div className="grid grid-cols-[auto_repeat(24,minmax(18px,1fr))] gap-0.5 text-[10px]">
          <div />
          {Array.from({ length: 24 }).map((_, h) => (
            <div key={h} className="text-center text-muted-foreground">
              {h % 3 === 0 ? h : ""}
            </div>
          ))}
          {DOWS.map((dowLabel, dow) => (
            <Fragment key={`row-${dow}`}>
              <div className="text-muted-foreground pr-1 self-center">{dowLabel}</div>
              {Array.from({ length: 24 }).map((_, h) => {
                const v = map.get(`${dow}-${h}`) ?? 0;
                const intensity = max ? v / max : 0;
                return (
                  <div
                    key={`c-${dow}-${h}`}
                    className="aspect-square rounded-sm"
                    style={{
                      background:
                        intensity === 0
                          ? "oklch(0.22 0.012 200)"
                          : `oklch(${0.35 + intensity * 0.35} 0.13 162 / ${0.3 + intensity * 0.7})`,
                    }}
                    title={`${dowLabel} ${h}h: ${v} recebidas`}
                  />
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Tab 3 — Equipe
// ============================================================================
function TeamTab({ days, channelIds }: { days: 7 | 30 | 90; channelIds: string[] }) {
  const fn = useServerFn(getTeamMetrics);
  const { data, isLoading, error } = useQuery({
    queryKey: ["report-team", days, channelIds],
    queryFn: () => fn({ data: { days, channelIds } }),
    staleTime: 60_000,
  });

  if (error) return <ErrorCard message={(error as Error).message} />;
  const agents = data?.agents ?? [];

  return (
    <>
      <Card className="p-4 mb-4">
        <h3 className="font-semibold mb-4">Mensagens enviadas por atendente</h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={agents} layout="vertical" margin={{ left: 8, right: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.32 0.012 200)" horizontal={false} />
              <XAxis type="number" stroke="oklch(0.68 0.012 200)" tick={{ fontSize: 11 }} allowDecimals={false} />
              <YAxis type="category" dataKey="agent_name" width={110} stroke="oklch(0.68 0.012 200)" tick={{ fontSize: 11 }} />
              <Tooltip contentStyle={{ background: "oklch(0.25 0.012 200)", border: "1px solid oklch(0.32 0.012 200)", borderRadius: 8 }} />
              <Bar dataKey="messages_sent" name="mensagens" fill={COLOR_OUT} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card className="p-4">
        <h3 className="font-semibold mb-4">Desempenho detalhado</h3>
        {isLoading ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Carregando…</p>
        ) : agents.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            Nenhuma atividade de atendente no período.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="py-2 pr-3 font-medium">Atendente</th>
                  <th className="py-2 pr-3 font-medium text-right">Convs.</th>
                  <th className="py-2 pr-3 font-medium text-right">Msgs</th>
                  <th className="py-2 pr-3 font-medium text-right">Resolvidas</th>
                  <th className="py-2 pr-3 font-medium text-right" title="First Contact Resolution">
                    1º contato
                  </th>
                  <th className="py-2 pr-3 font-medium text-right">1ª resposta</th>
                  <th className="py-2 pr-3 font-medium text-right" title="Average Handle Time">
                    AHT
                  </th>
                  <th className="py-2 font-medium text-right" title="Conversas simultâneas (proxy por hora)">
                    Carga (méd/pico)
                  </th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.agent_id} className="border-b border-border/50 last:border-0">
                    <td className="py-2.5 pr-3 font-medium">{a.agent_name}</td>
                    <td className="py-2.5 pr-3 text-right">{a.conversations_attended}</td>
                    <td className="py-2.5 pr-3 text-right">{a.messages_sent}</td>
                    <td className="py-2.5 pr-3 text-right">{a.resolved_count}</td>
                    <td className="py-2.5 pr-3 text-right">
                      {a.first_contact_resolution_count}
                      {a.resolved_count > 0 && (
                        <span className="text-[10px] text-muted-foreground ml-1">
                          ({pct(a.first_contact_resolution_count, a.resolved_count)})
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-right">
                      {formatDuration(a.avg_first_response_secs)}
                    </td>
                    <td className="py-2.5 pr-3 text-right">{formatDuration(a.aht_secs)}</td>
                    <td className="py-2.5 text-right">
                      {a.concurrent_avg.toFixed(1)} / {a.concurrent_peak}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground mt-3">
          <strong>AHT</strong> = tempo médio de atendimento (criação → resolução).{" "}
          <strong>1º contato</strong> = resolvidas com uma única troca inbound→outbound.{" "}
          <strong>Carga</strong> = média e pico de conversas distintas atendidas na mesma hora.
        </p>
      </Card>
    </>
  );
}

// ============================================================================
// Tab 4 — Assuntos & canais
// ============================================================================
function TopicsTab({ days, channelIds }: { days: 7 | 30 | 90; channelIds: string[] }) {
  const fn = useServerFn(getTopicsMetrics);
  const { data, isLoading, error } = useQuery({
    queryKey: ["report-topics", days, channelIds],
    queryFn: () => fn({ data: { days, channelIds } }),
    staleTime: 60_000,
  });

  if (error) return <ErrorCard message={(error as Error).message} />;
  const topTags = data?.topTags ?? [];
  const channelsBreak = data?.channels ?? [];
  const fu = data?.followups;

  const totalFu = (fu?.scheduled_count ?? 0);
  const upcoming = useMemo(() => fu?.upcoming ?? [], [fu]);

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-4">
            <TagIcon className="w-4 h-4 text-chart-3" />
            <h3 className="font-semibold">Top assuntos (tags)</h3>
          </div>
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Carregando…</p>
          ) : topTags.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Nenhuma conversa com tag no período.
            </p>
          ) : (
            <div className="space-y-2">
              {topTags.map((t) => {
                const max = topTags[0].conversations_count || 1;
                const width = (t.conversations_count / max) * 100;
                return (
                  <div key={t.tag_name} className="text-sm">
                    <div className="flex justify-between mb-1">
                      <span className="capitalize">{t.tag_name}</span>
                      <span className="text-muted-foreground text-xs">
                        {t.conversations_count}
                      </span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary/70 rounded-full"
                        style={{ width: `${width}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-2 mb-4">
            <Radio className="w-4 h-4 text-chart-2" />
            <h3 className="font-semibold">Desempenho por canal</h3>
          </div>
          {channelsBreak.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Sem atividade por canal no período.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border">
                    <th className="py-2 pr-3 font-medium">Canal</th>
                    <th className="py-2 pr-3 font-medium text-right">Recebidas</th>
                    <th className="py-2 pr-3 font-medium text-right">Enviadas</th>
                    <th className="py-2 pr-3 font-medium text-right">Convs.</th>
                    <th className="py-2 font-medium text-right">1ª resposta</th>
                  </tr>
                </thead>
                <tbody>
                  {channelsBreak.map((c) => (
                    <tr key={c.channel_id} className="border-b border-border/50 last:border-0">
                      <td className="py-2 pr-3">
                        <div className="font-medium">{c.channel_name}</div>
                        <div className="text-[10px] uppercase text-muted-foreground">
                          {c.channel_type}
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-right">{c.inbound_count}</td>
                      <td className="py-2 pr-3 text-right">{c.outbound_count}</td>
                      <td className="py-2 pr-3 text-right">{c.conversations_count}</td>
                      <td className="py-2 text-right">
                        {formatDuration(c.avg_first_response_secs)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-4">
          <CalendarClock className="w-4 h-4 text-chart-4" />
          <h3 className="font-semibold">Follow-ups automáticos</h3>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <MiniStat label="Agendados no período" value={totalFu} tone="text-chart-4" />
          <MiniStat label="Enviados" value={fu?.sent_count ?? 0} tone="text-emerald-400" />
          <MiniStat label="Cancelados" value={fu?.cancelled_count ?? 0} tone="text-muted-foreground" />
          <MiniStat label="Com erro" value={fu?.failed_count ?? 0} tone="text-rose-400" />
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-2">Próximos pendentes</div>
          {upcoming.length === 0 ? (
            <p className="text-sm text-muted-foreground py-3">Nenhum follow-up pendente.</p>
          ) : (
            <ul className="text-sm divide-y divide-border/50">
              {upcoming.map((u) => (
                <li key={u.id} className="py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{u.contact_name ?? "—"}</div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      Tag: {u.tag_name ?? "—"}
                    </div>
                  </div>
                  <Badge variant="outline" className="text-[10px]">
                    {new Date(u.send_at).toLocaleString("pt-BR", {
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`text-xl font-bold mt-1 ${tone}`}>{value}</div>
    </div>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <Card className="p-6 text-sm text-destructive">Falha ao carregar métricas: {message}</Card>
  );
}
