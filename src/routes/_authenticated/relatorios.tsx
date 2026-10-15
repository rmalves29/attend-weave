import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useMemo, Fragment, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getOverviewMetrics, getSlaMetrics, getTeamMetrics, getTopicsMetrics, getChannelsForFilter,
} from "@/lib/reports.functions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip as UiTooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  MessageSquare, Users, CheckCircle2, Timer, Inbox, Send, AlertTriangle, Filter,
  Tag as TagIcon, CalendarClock, ArrowUpRight, ArrowDownRight, Minus, Info, Sparkles,
  MoonStar, MessageCircleOff, Hourglass,
} from "lucide-react";
import {
  XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid, Legend,
} from "recharts";

export const Route = createFileRoute("/_authenticated/relatorios")({
  head: () => ({
    meta: [
      { title: "Relatórios — AttendFlow" },
      { name: "description", content: "Métricas gerenciais do atendimento: tempos de resposta, equipe e canais." },
      { property: "og:title", content: "Relatórios — AttendFlow" },
      { property: "og:description", content: "Métricas gerenciais do atendimento." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: RelatoriosPage,
});

const PERIODS = [
  { days: 7 as const, label: "7 dias" },
  { days: 30 as const, label: "30 dias" },
  { days: 90 as const, label: "90 dias" },
];
const COLOR_IN = "var(--chart-2)";
const COLOR_OUT = "var(--primary)";
const DOWS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

type Filters = { days: 7 | 30 | 90; channelIds: string[]; until: string; includeGroups: boolean };

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
function pct(n: number | undefined, d: number | undefined): string {
  if (!d) return "—";
  return `${Math.round(((n ?? 0) / d) * 100)}%`;
}

function DeltaBadge({ current, previous, inverted = false }: { current: number | null | undefined; previous: number | null | undefined; inverted?: boolean }) {
  if (current == null || previous == null || previous === 0) return <span className="text-[11px] text-muted-foreground">—</span>;
  const delta = ((current - previous) / previous) * 100;
  const abs = Math.abs(delta);
  if (abs < 0.5) return <span className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground"><Minus className="w-3 h-3" /> 0%</span>;
  const good = inverted ? delta < 0 : delta > 0;
  const Icon = delta > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-medium ${good ? "text-emerald-600" : "text-rose-600"}`}>
      <Icon className="w-3 h-3" />{abs.toFixed(abs < 10 ? 1 : 0)}%
    </span>
  );
}

function InfoTip({ text }: { text: string }) {
  return (
    <UiTooltip>
      <TooltipTrigger asChild>
        <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="Como é calculado">
          <Info className="w-3.5 h-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">{text}</TooltipContent>
    </UiTooltip>
  );
}

function Kpi({ label, value, icon: Icon, info, sub, tone }: { label: string; value: ReactNode; icon: any; info: string; sub?: ReactNode; tone?: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground flex items-center gap-1">{label} <InfoTip text={info} /></span>
        <Icon className={`w-4 h-4 ${tone ?? "text-primary"}`} />
      </div>
      <div className="text-2xl font-bold mt-2">{value}</div>
      {sub && <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>}
    </Card>
  );
}

function RelatoriosPage() {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [includeGroups, setIncludeGroups] = useState(false);
  const [tab, setTab] = useState("overview");
  const until = useMemo(
    () => new Date().toISOString(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [days, channelIds, includeGroups],
  );
  const f: Filters = { days, channelIds, until, includeGroups };

  const channelsFn = useServerFn(getChannelsForFilter);
  const { data: channelList } = useQuery({ queryKey: ["report-channels"], queryFn: () => channelsFn(), staleTime: 300_000 });

  return (
    <TooltipProvider delayDuration={150}>
      <div className="h-full overflow-y-auto p-6 max-w-7xl mx-auto">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Relatórios</h1>
            <p className="text-muted-foreground text-sm mt-1">Visão gerencial do atendimento — tempos, equipe e canais.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild size="sm" className="h-8">
              <Link to="/analise-ia"><Sparkles className="w-3.5 h-3.5 mr-1.5" />Analisar conversas com IA</Link>
            </Button>
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={includeGroups} onCheckedChange={setIncludeGroups} />
              Incluir grupos
            </label>
            <ChannelFilter channels={channelList ?? []} selected={channelIds} onChange={setChannelIds} />
            <div className="flex gap-1 text-xs">
              {PERIODS.map((p) => (
                <button key={p.days} onClick={() => setDays(p.days)}
                  className={`px-3 py-1.5 rounded-full transition-colors ${days === p.days ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"}`}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </header>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="overview">Visão geral</TabsTrigger>
            <TabsTrigger value="sla">Tempos de resposta</TabsTrigger>
            <TabsTrigger value="team">Equipe</TabsTrigger>
            <TabsTrigger value="topics">Etiquetas &amp; canais</TabsTrigger>
          </TabsList>
          <TabsContent value="overview"><OverviewTab f={f} /></TabsContent>
          <TabsContent value="sla"><SlaTab f={f} /></TabsContent>
          <TabsContent value="team"><TeamTab f={f} /></TabsContent>
          <TabsContent value="topics"><TopicsTab f={f} /></TabsContent>
        </Tabs>
      </div>
    </TooltipProvider>
  );
}

function ChannelFilter({ channels, selected, onChange }: { channels: { id: string; name: string; type: string }[]; selected: string[]; onChange: (v: string[]) => void }) {
  const label = selected.length === 0 ? "Todos os canais" : selected.length === 1 ? channels.find((c) => c.id === selected[0])?.name ?? "1 canal" : `${selected.length} canais`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 text-xs"><Filter className="w-3.5 h-3.5 mr-1.5" />{label}</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <div className="text-xs text-muted-foreground px-2 py-1.5">Filtrar por canal</div>
        <div className="max-h-64 overflow-y-auto">
          {channels.map((c) => (
            <label key={c.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent cursor-pointer">
              <Checkbox checked={selected.includes(c.id)} onCheckedChange={(v) => onChange(v ? [...selected, c.id] : selected.filter((id) => id !== c.id))} />
              <span className="text-sm truncate flex-1">{c.name}</span>
              <span className="text-[10px] uppercase text-muted-foreground">{c.type}</span>
            </label>
          ))}
        </div>
        {selected.length > 0 && <Button variant="ghost" size="sm" className="w-full mt-1 text-xs h-7" onClick={() => onChange([])}>Limpar</Button>}
      </PopoverContent>
    </Popover>
  );
}

function ErrorCard({ message }: { message: string }) {
  return <Card className="p-6 text-sm text-destructive">Erro ao carregar: {message}</Card>;
}

function useReport<T>(key: string, fn: (a: { data: any }) => Promise<T>, f: Filters) {
  return useQuery({
    queryKey: [key, f.days, f.channelIds, f.until, f.includeGroups],
    queryFn: () => fn({ data: { days: f.days, channelIds: f.channelIds, until: f.until, includeGroups: f.includeGroups } }),
    staleTime: 60_000,
  });
}

const vsPrev = (curr: any, prev: any, inverted = false) => (
  <><DeltaBadge current={curr} previous={prev} inverted={inverted} /> <span>vs. período anterior</span></>
);

function OverviewTab({ f }: { f: Filters }) {
  const fn = useServerFn(getOverviewMetrics);
  const { data, isLoading, error } = useReport("report-overview-v3", fn, f);
  if (error) return <ErrorCard message={(error as Error).message} />;
  const ov = data?.overview;
  const pv = data?.previous;
  const L = (v: ReactNode) => (isLoading ? "…" : v);
  const daily = (data?.daily ?? []).map((d) => ({ date: d.day.slice(5), recebidas: d.inbound, enviadas: d.outbound }));

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Kpi label="Recebidas" icon={Inbox} tone="text-chart-2" value={L(ov?.inbound_count ?? 0)} sub={vsPrev(ov?.inbound_count, pv?.inbound_count)}
          info="Mensagens recebidas de clientes no período (sem notas internas)." />
        <Kpi label="Enviadas" icon={Send} value={L(ov?.outbound_count ?? 0)} sub={vsPrev(ov?.outbound_count, pv?.outbound_count)}
          info="Mensagens enviadas pela loja no período, pelo sistema ou pelo celular." />
        <Kpi label="Conversas ativas" icon={MessageSquare} tone="text-chart-3" value={L(ov?.conversations_active ?? 0)} sub={vsPrev(ov?.conversations_active, pv?.conversations_active)}
          info="Conversas com ao menos uma mensagem no período." />
        <Kpi label="Novas conversas" icon={Users} tone="text-chart-5" value={L(ov?.conversations_new ?? 0)} sub={<>{ov?.contacts_new ?? 0} contatos novos · {vsPrev(ov?.conversations_new, pv?.conversations_new)}</>}
          info="Conversas/contatos cuja PRIMEIRA mensagem caiu no período (não conta importação de histórico)." />
        <Kpi label="1ª resposta (mediana)" icon={Timer} tone="text-chart-2" value={L(formatDuration(ov?.p50_first_response_secs))} sub={<>p90 {formatDuration(ov?.p90_first_response_secs)} · {vsPrev(ov?.p50_first_response_secs, pv?.p50_first_response_secs, true)}</>}
          info="Por turno: da 1ª mensagem do cliente após uma resposta da loja até a próxima resposta humana (bot e follow-ups não contam)." />
        <Kpi label="Turnos sem resposta" icon={MessageCircleOff} tone="text-rose-600" value={L(pct(ov?.turns_unanswered, ov?.turns_total))} sub={<>{ov?.turns_unanswered ?? 0} de {ov?.turns_total ?? 0} turnos</>}
          info="Turnos do cliente que ainda não receberam nenhuma resposta humana." />
        <Kpi label="Resolvidas por atendente" icon={CheckCircle2} value={L(ov?.resolved_by_agent ?? 0)} sub={<>Tempo mediano {formatDuration(ov?.p50_resolution_secs)}</>}
          info="Conversas encerradas por um atendente. Tempo: do 1º contato do cliente no ciclo (após ≥24h sem mensagens) até o encerramento." />
        <Kpi label="Finalizadas por inatividade" icon={MoonStar} tone="text-muted-foreground" value={L(ov?.auto_finalized ?? 0)} sub="Fechadas automaticamente"
          info="Conversas fechadas pela rotina automática por falta de atividade, sem atendente." />
      </div>

      <Card className="p-4">
        <h3 className="font-semibold mb-4 flex items-center gap-1">Fluxo de mensagens por dia <InfoTip text="Mensagens recebidas e enviadas por dia (horário de Brasília)." /></h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" stroke="var(--muted-foreground)" tick={{ fontSize: 11 }} />
              <YAxis stroke="var(--muted-foreground)" tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8 }} />
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

function SlaTab({ f }: { f: Filters }) {
  const fn = useServerFn(getSlaMetrics);
  const { data, isLoading, error } = useReport("report-sla-v3", fn, f);
  if (error) return <ErrorCard message={(error as Error).message} />;
  const ov = data?.overview;
  const total = ov?.turns_total ?? 0;
  const oldest = ov?.oldest_open_secs ?? null;
  const tone = oldest == null ? "text-muted-foreground" : oldest > 3600 ? "text-rose-600" : oldest > 900 ? "text-amber-600" : "text-emerald-600";
  const buckets = [
    { label: "≤ 5 min", value: ov?.sla_5m_count ?? 0, cls: "bg-emerald-500" },
    { label: "5–15 min", value: (ov?.sla_15m_count ?? 0) - (ov?.sla_5m_count ?? 0), cls: "bg-sky-500" },
    { label: "15–60 min", value: (ov?.sla_1h_count ?? 0) - (ov?.sla_15m_count ?? 0), cls: "bg-amber-500" },
    { label: "> 1 h", value: (ov?.turns_answered ?? 0) - (ov?.sla_1h_count ?? 0), cls: "bg-orange-600" },
    { label: "Sem resposta", value: ov?.turns_unanswered ?? 0, cls: "bg-rose-600" },
  ];
  const L = (v: ReactNode) => (isLoading ? "…" : v);

  const heat = new Map<string, number>();
  let max = 0;
  for (const c of data?.heatmap ?? []) { heat.set(`${c.dow}-${c.hour}`, c.inbound); max = Math.max(max, c.inbound); }

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <Kpi label="Mediana" icon={Timer} value={L(formatDuration(ov?.p50_first_response_secs))} info="Metade dos turnos respondidos teve 1ª resposta até este tempo." />
        <Kpi label="p90" icon={Hourglass} tone="text-amber-600" value={L(formatDuration(ov?.p90_first_response_secs))} info="90% dos turnos respondidos tiveram 1ª resposta até este tempo." />
        <Kpi label="Respondidos em 5 min" icon={CheckCircle2} tone="text-emerald-600" value={L(pct(ov?.sla_5m_count, total))} sub={<>15 min: {pct(ov?.sla_15m_count, total)} · 1 h: {pct(ov?.sla_1h_count, total)}</>}
          info="Percentual de todos os turnos (incluindo os sem resposta) respondidos dentro do limite." />
        <Kpi label="Turnos sem resposta" icon={MessageCircleOff} tone="text-rose-600" value={L(pct(ov?.turns_unanswered, total))} sub={`${ov?.turns_unanswered ?? 0} turnos`} info="Turnos do cliente sem nenhuma resposta humana até agora." />
        <Kpi label="Aguardando agora" icon={AlertTriangle} tone={tone} value={L(ov?.open_now_count ?? 0)} sub={oldest == null ? "Ninguém esperando" : `Mais antiga: ${formatDuration(oldest)}`}
          info="Conversas abertas cuja última mensagem é do cliente (independe do período)." />
      </div>

      <Card className="p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold flex items-center gap-1">Distribuição da 1ª resposta <InfoTip text="Todos os turnos do período, agrupados pelo tempo até a 1ª resposta humana." /></span>
          <span className="text-[11px] text-muted-foreground">{total} turnos</span>
        </div>
        {total === 0 ? <p className="text-xs text-muted-foreground py-4">Sem dados no período.</p> : (
          <>
            <div className="flex h-3 rounded-full overflow-hidden bg-muted">
              {buckets.map((b) => <div key={b.label} className={b.cls} style={{ width: `${(b.value / total) * 100}%` }} title={`${b.label}: ${b.value}`} />)}
            </div>
            <div className="flex flex-wrap gap-4 mt-3 text-xs">
              {buckets.map((b) => <span key={b.label} className="flex items-center gap-1.5"><span className={`w-2.5 h-2.5 rounded-sm ${b.cls}`} />{b.label}: <b>{b.value}</b> ({pct(b.value, total)})</span>)}
            </div>
          </>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="text-sm font-semibold mb-3 flex items-center gap-1">Picos de mensagens recebidas <InfoTip text="Mensagens de clientes por dia da semana e hora (horário de Brasília)." /></h3>
        <div className="overflow-x-auto">
          <div className="grid gap-[2px] min-w-[640px]" style={{ gridTemplateColumns: "40px repeat(24, 1fr)" }}>
            <div />
            {Array.from({ length: 24 }, (_, h) => <div key={h} className="text-[9px] text-muted-foreground text-center">{h}</div>)}
            {DOWS.map((d, dow) => (
              <Fragment key={d}>
                <div className="text-[10px] text-muted-foreground">{d}</div>
                {Array.from({ length: 24 }, (_, h) => {
                  const v = heat.get(`${dow}-${h}`) ?? 0;
                  return <div key={h} className="h-5 rounded-sm bg-primary" style={{ opacity: max ? 0.06 + (v / max) * 0.94 : 0.06 }} title={`${d} ${h}h: ${v}`} />;
                })}
              </Fragment>
            ))}
          </div>
        </div>
      </Card>
    </>
  );
}

function TeamTab({ f }: { f: Filters }) {
  const fn = useServerFn(getTeamMetrics);
  const { data, isLoading, error } = useReport("report-team-v3", fn, f);
  if (error) return <ErrorCard message={(error as Error).message} />;
  const agents = data?.agents ?? [];
  return (
    <Card className="p-4 overflow-x-auto">
      <h3 className="font-semibold mb-3 flex items-center gap-1">Desempenho por atendente <InfoTip text="Mensagens enviadas pelo celular (sem atendente identificado) aparecem numa linha própria." /></h3>
      {isLoading ? <p className="text-sm text-muted-foreground">Carregando…</p> : agents.length === 0 ? <p className="text-sm text-muted-foreground">Sem atividade no período.</p> : (
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="text-left border-b border-border">
              <th className="py-2">Atendente</th>
              <th className="py-2 text-right">Mensagens <InfoTipInline text="Mensagens enviadas (sem bot/follow-up automático)." /></th>
              <th className="py-2 text-right">Conversas <InfoTipInline text="Conversas distintas em que enviou mensagem." /></th>
              <th className="py-2 text-right">Turnos respondidos <InfoTipInline text="Turnos em que foi o primeiro a responder." /></th>
              <th className="py-2 text-right">1ª resposta (mediana) <InfoTipInline text="Mesma lógica de turnos da visão geral." /></th>
              <th className="py-2 text-right">Resolvidas <InfoTipInline text="Conversas encerradas por este atendente." /></th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.agent_id ?? "none"} className="border-b border-border/60">
                <td className={`py-2 ${a.agent_id ? "font-medium" : "italic text-muted-foreground"}`}>{a.agent_name}</td>
                <td className="py-2 text-right">{a.messages_sent}</td>
                <td className="py-2 text-right">{a.conversations_attended}</td>
                <td className="py-2 text-right">{a.turns_answered}</td>
                <td className="py-2 text-right">{formatDuration(a.p50_first_response_secs)}</td>
                <td className="py-2 text-right">{a.resolved_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function InfoTipInline({ text }: { text: string }) {
  return <span className="inline-flex align-middle ml-0.5"><InfoTip text={text} /></span>;
}

function TopicsTab({ f }: { f: Filters }) {
  const fn = useServerFn(getTopicsMetrics);
  const { data, isLoading, error } = useReport("report-topics-v3", fn, f);
  if (error) return <ErrorCard message={(error as Error).message} />;
  const tags = data?.topTags ?? [];
  const fu = data?.followups;
  const maxTag = Math.max(1, ...tags.map((t) => t.conversations_count));
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card className="p-4">
        <h3 className="font-semibold mb-3 flex items-center gap-1"><TagIcon className="w-4 h-4" /> Etiquetas mais usadas <InfoTip text="Conversas com mensagens no período, por etiqueta aplicada." /></h3>
        {isLoading ? <p className="text-sm text-muted-foreground">Carregando…</p> : tags.length === 0 ? (
          <EmptyExplain>
            Nenhuma conversa tem etiqueta ainda ({data?.tagsRegistered ?? 0} etiquetas cadastradas, {data?.conversationsWithTags ?? 0} conversas etiquetadas).
            Não é erro: este gráfico passa a mostrar dados quando a equipe começar a etiquetar as conversas no Atendimento.
          </EmptyExplain>
        ) : (
          <div className="space-y-2">
            {tags.map((t) => (
              <div key={t.tag_name} className="text-sm">
                <div className="flex justify-between text-xs mb-1"><span>{t.tag_name}</span><b>{t.conversations_count}</b></div>
                <div className="h-2 rounded bg-muted"><div className="h-2 rounded bg-primary" style={{ width: `${(t.conversations_count / maxTag) * 100}%` }} /></div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="font-semibold mb-3 flex items-center gap-1"><CalendarClock className="w-4 h-4" /> Follow-ups automáticos <InfoTip text="Mensagens automáticas agendadas pelas etiquetas com automação." /></h3>
        {fu && fu.scheduled_count + fu.sent_count + fu.cancelled_count + fu.failed_count === 0 ? (
          <EmptyExplain>
            Nenhum follow-up no período. Eles só são criados quando uma etiqueta com automação é aplicada a uma conversa — configure em Configurações → Etiquetas.
          </EmptyExplain>
        ) : (
          <div className="grid grid-cols-4 gap-2 text-center">
            {[["Agendados", fu?.scheduled_count], ["Enviados", fu?.sent_count], ["Cancelados", fu?.cancelled_count], ["Falharam", fu?.failed_count]].map(([l, v]) => (
              <div key={l as string} className="rounded-lg bg-muted p-2"><div className="text-xl font-bold">{v ?? 0}</div><div className="text-[11px] text-muted-foreground">{l}</div></div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-4 md:col-span-2 overflow-x-auto">
        <h3 className="font-semibold mb-3 flex items-center gap-1">Por canal <InfoTip text="Mesma lógica de turnos da visão geral, separada por canal." /></h3>
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="text-left border-b border-border">
              <th className="py-2">Canal</th><th className="py-2 text-right">Recebidas</th><th className="py-2 text-right">Enviadas</th>
              <th className="py-2 text-right">Conversas</th><th className="py-2 text-right">Turnos</th><th className="py-2 text-right">Sem resposta</th><th className="py-2 text-right">1ª resposta (mediana)</th>
            </tr>
          </thead>
          <tbody>
            {(data?.channels ?? []).map((c) => (
              <tr key={c.channel_id} className="border-b border-border/60">
                <td className="py-2">{c.channel_name} <span className="text-[10px] uppercase text-muted-foreground">{c.channel_type}</span></td>
                <td className="py-2 text-right">{c.inbound_count}</td><td className="py-2 text-right">{c.outbound_count}</td>
                <td className="py-2 text-right">{c.conversations_count}</td><td className="py-2 text-right">{c.turns_total}</td>
                <td className="py-2 text-right">{pct(c.turns_unanswered, c.turns_total)}</td>
                <td className="py-2 text-right">{formatDuration(c.p50_first_response_secs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function EmptyExplain({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground bg-muted/50 rounded-lg p-3 leading-relaxed">{children}</p>;
}
