import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getReportMetrics } from "@/lib/reports.functions";
import { Card } from "@/components/ui/card";
import {
  MessageSquare,
  Users,
  Clock,
  CheckCircle2,
  TrendingUp,
  Timer,
  Inbox,
  Send,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  Legend,
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

function RelatoriosPage() {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const metricsFn = useServerFn(getReportMetrics);

  const { data, isLoading, error } = useQuery({
    queryKey: ["report-metrics", days],
    queryFn: () => metricsFn({ data: { days } }),
    staleTime: 60_000,
  });

  const ov = data?.overview;
  const daily = (data?.daily ?? []).map((d) => ({
    date: d.day.slice(5),
    recebidas: d.inbound,
    enviadas: d.outbound,
  }));
  const agents = data?.agents ?? [];

  const kpis = [
    { label: "Recebidas", value: ov?.inbound_count ?? 0, icon: Inbox, color: "text-chart-2" },
    { label: "Enviadas", value: ov?.outbound_count ?? 0, icon: Send, color: "text-primary" },
    {
      label: "Conversas atendidas",
      value: ov?.conversations_active ?? 0,
      icon: MessageSquare,
      color: "text-chart-3",
    },
    {
      label: "Resolvidas",
      value: ov?.conversations_resolved ?? 0,
      icon: CheckCircle2,
      color: "text-primary",
    },
    {
      label: "Em aberto agora",
      value: ov?.conversations_open_now ?? 0,
      icon: Clock,
      color: "text-chart-4",
    },
    { label: "Contatos novos", value: ov?.contacts_new ?? 0, icon: Users, color: "text-chart-5" },
    {
      label: "1ª resposta (média)",
      value: formatDuration(ov?.avg_first_response_secs),
      icon: Timer,
      color: "text-chart-2",
    },
    {
      label: "Resolução (média)",
      value: formatDuration(ov?.avg_resolution_secs),
      icon: TrendingUp,
      color: "text-chart-3",
    },
  ];

  return (
    <div className="h-full overflow-y-auto p-6 max-w-7xl mx-auto">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Relatórios</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Fluxo de mensagens e desempenho da equipe — todos os canais.
          </p>
        </div>
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
      </header>

      {error ? (
        <Card className="p-6 text-sm text-destructive">
          Falha ao carregar métricas: {(error as Error).message}
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            {kpis.map((k) => (
              <Card key={k.label} className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{k.label}</span>
                  <k.icon className={`w-4 h-4 ${k.color}`} />
                </div>
                <div className="text-2xl font-bold mt-2">{isLoading ? "…" : k.value}</div>
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
            <Card className="p-4 lg:col-span-2">
              <h3 className="font-semibold mb-4">Fluxo de mensagens por dia</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={daily}>
                    <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.32 0.012 200)" />
                    <XAxis dataKey="date" stroke="oklch(0.68 0.012 200)" tick={{ fontSize: 11 }} />
                    <YAxis
                      stroke="oklch(0.68 0.012 200)"
                      tick={{ fontSize: 11 }}
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "oklch(0.25 0.012 200)",
                        border: "1px solid oklch(0.32 0.012 200)",
                        borderRadius: 8,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line
                      type="monotone"
                      dataKey="recebidas"
                      stroke={COLOR_IN}
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="enviadas"
                      stroke={COLOR_OUT}
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="p-4">
              <h3 className="font-semibold mb-4">Mensagens enviadas por atendente</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={agents} layout="vertical" margin={{ left: 8, right: 8 }}>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="oklch(0.32 0.012 200)"
                      horizontal={false}
                    />
                    <XAxis
                      type="number"
                      stroke="oklch(0.68 0.012 200)"
                      tick={{ fontSize: 11 }}
                      allowDecimals={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="agent_name"
                      width={90}
                      stroke="oklch(0.68 0.012 200)"
                      tick={{ fontSize: 11 }}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "oklch(0.25 0.012 200)",
                        border: "1px solid oklch(0.32 0.012 200)",
                        borderRadius: 8,
                      }}
                    />
                    <Bar
                      dataKey="messages_sent"
                      name="mensagens"
                      fill={COLOR_OUT}
                      radius={[0, 4, 4, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <Card className="p-4">
            <h3 className="font-semibold mb-4">Desempenho por atendente</h3>
            {agents.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                Nenhuma atividade de atendente no período.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b border-border">
                      <th className="py-2 pr-4 font-medium">Atendente</th>
                      <th className="py-2 pr-4 font-medium text-right">Conversas atendidas</th>
                      <th className="py-2 pr-4 font-medium text-right">Msgs enviadas</th>
                      <th className="py-2 pr-4 font-medium text-right">Resolvidas</th>
                      <th className="py-2 font-medium text-right">1ª resposta (média)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agents.map((a) => (
                      <tr key={a.agent_id} className="border-b border-border/50 last:border-0">
                        <td className="py-2.5 pr-4 font-medium">{a.agent_name}</td>
                        <td className="py-2.5 pr-4 text-right">{a.conversations_attended}</td>
                        <td className="py-2.5 pr-4 text-right">{a.messages_sent}</td>
                        <td className="py-2.5 pr-4 text-right">{a.resolved_count}</td>
                        <td className="py-2.5 text-right">
                          {formatDuration(a.avg_first_response_secs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground mt-3">
              1ª resposta = tempo médio entre a mensagem do cliente e a primeira resposta do
              atendente. Mensagens enviadas fora do painel (celular) contam no fluxo geral, mas não
              no desempenho individual. Notas internas não entram nas métricas.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
