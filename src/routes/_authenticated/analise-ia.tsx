import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import {
  getAiContext, previewAiAnalysis, createAiAnalysis, listAiAnalyses, getAiAnalysis,
  saveBancoAsQuickReplies, redoAiAnalysis, type AiFilters, type AiAnalysisRow,
} from "@/lib/ai-analysis.functions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sparkles, ArrowLeft, Download, Printer, Copy, MessageSquarePlus, RotateCcw, Loader2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/analise-ia")({
  head: () => ({
    meta: [
      { title: "Análise com IA — AttendFlow" },
      { name: "description", content: "A IA lê as conversas do período e gera um padrão de atendimento com acertos, erros e banco de respostas." },
      { property: "og:title", content: "Análise com IA — AttendFlow" },
      { property: "og:description", content: "Padrão de atendimento gerado a partir das conversas reais." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AnalisePage,
});

const STATUS: Record<AiAnalysisRow["status"], { label: string; cls: string }> = {
  queued: { label: "Na fila", cls: "bg-muted text-muted-foreground" },
  running: { label: "Lendo conversas", cls: "bg-primary/15 text-primary" },
  summarizing: { label: "Escrevendo documento", cls: "bg-primary/15 text-primary" },
  done: { label: "Pronto", cls: "bg-emerald-500/15 text-emerald-700" },
  error: { label: "Erro", cls: "bg-destructive/15 text-destructive" },
};
const d = (s: string) => new Date(s).toLocaleDateString("pt-BR");
const slug = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function AnalisePage() {
  const [openId, setOpenId] = useState<string | null>(null);
  const ctxFn = useServerFn(getAiContext);
  const { data: ctx } = useQuery({ queryKey: ["ai-context"], queryFn: () => ctxFn() });
  return (
    <div className="h-full overflow-y-auto">
      {openId ? (
        <ResultView id={openId} isAdmin={!!ctx?.isAdmin} onBack={() => setOpenId(null)} onOpen={setOpenId} />
      ) : (
        <div className="p-6 max-w-6xl mx-auto">
          <header className="mb-6">
            <h1 className="text-2xl font-bold flex items-center gap-2"><Sparkles className="w-6 h-6 text-primary" /> Análise com IA</h1>
            <p className="text-muted-foreground text-sm mt-1">A IA lê as conversas do período e escreve o que está certo, o que está errado e um padrão de atendimento com banco de respostas.</p>
          </header>
          {ctx?.isAdmin ? <NewAnalysisForm ctx={ctx} onCreated={setOpenId} /> : ctx ? (
            <Card className="p-4 mb-6 text-sm text-muted-foreground">Só administradores podem iniciar uma análise. Você pode ler as análises abaixo.</Card>
          ) : null}
          <AnalysisList onOpen={setOpenId} />
        </div>
      )}
    </div>
  );
}

function NewAnalysisForm({ ctx, onCreated }: { ctx: { storeContext: string; channels: { id: string; name: string }[] }; onCreated: (id: string) => void }) {
  const [preset, setPreset] = useState<AiFilters["preset"]>(90);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [channelId, setChannelId] = useState<string>("all");
  const [includeGroups, setIncludeGroups] = useState(false);
  const [minMessages, setMinMessages] = useState(3);
  const [storeContext, setStoreContext] = useState(ctx.storeContext);
  const filters: AiFilters = {
    preset, since: since || undefined, until: until || undefined,
    channelId: channelId === "all" ? null : channelId, includeGroups, minMessages,
  };
  const ready = preset !== "custom" || (since && until);
  const previewFn = useServerFn(previewAiAnalysis);
  const preview = useQuery({
    queryKey: ["ai-preview", filters],
    queryFn: () => previewFn({ data: filters }),
    enabled: !!ready,
  });
  const qc = useQueryClient();
  const createFn = useServerFn(createAiAnalysis);
  const create = useMutation({
    mutationFn: () => createFn({ data: { filters, storeContext } }),
    onSuccess: (r) => { toast.success("Análise iniciada. Ela continua mesmo se você fechar a página."); qc.invalidateQueries({ queryKey: ["ai-analyses"] }); onCreated(r.id); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card className="p-5 mb-6">
      <h2 className="font-semibold mb-4">Nova análise</h2>
      <div className="grid gap-4 md:grid-cols-4">
        <div className="space-y-1.5">
          <Label>Período</Label>
          <Select value={String(preset)} onValueChange={(v) => setPreset(v === "custom" ? "custom" : (Number(v) as 7 | 30 | 90))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Últimos 7 dias</SelectItem>
              <SelectItem value="30">Últimos 30 dias</SelectItem>
              <SelectItem value="90">Últimos 90 dias</SelectItem>
              <SelectItem value="custom">Datas personalizadas</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {preset === "custom" && (
          <>
            <div className="space-y-1.5"><Label>De</Label><Input type="date" value={since} onChange={(e) => setSince(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Até</Label><Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></div>
          </>
        )}
        <div className="space-y-1.5">
          <Label>Canal</Label>
          <Select value={channelId} onValueChange={setChannelId}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os canais</SelectItem>
              {ctx.channels.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Mín. de mensagens por conversa</Label>
          <Input type="number" min={1} max={50} value={minMessages} onChange={(e) => setMinMessages(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
        </div>
        <label className="flex items-center gap-2 text-sm self-end pb-2">
          <Switch checked={includeGroups} onCheckedChange={setIncludeGroups} /> Incluir grupos
        </label>
      </div>
      <div className="space-y-1.5 mt-4">
        <Label>Contexto da loja (opcional)</Label>
        <Textarea rows={4} value={storeContext} onChange={(e) => setStoreContext(e.target.value)}
          placeholder="O que a loja vende, políticas de frete, troca e pagamento… A IA usa isso para não inventar regras. Fica salvo para as próximas análises." />
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          {!ready ? "Escolha as datas." : preview.isLoading ? "Contando conversas…" : preview.error ? (preview.error as Error).message : preview.data && (
            <>
              <b className="text-foreground">{preview.data.conversations}</b> conversas · <b className="text-foreground">{preview.data.messages}</b> mensagens · cerca de <b className="text-foreground">{preview.data.estimatedMinutes} min</b>
              {preview.data.sampled && <span className="block text-amber-700">Há {preview.data.totalAvailable} conversas; serão analisadas as 1.500 mais recentes.</span>}
            </>
          )}
        </div>
        <Button onClick={() => create.mutate()} disabled={!ready || create.isPending || !preview.data?.conversations}>
          {create.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
          Iniciar análise
        </Button>
      </div>
    </Card>
  );
}

function ProgressCell({ a }: { a: { status: AiAnalysisRow["status"]; total_conversations: number; processed_conversations: number } }) {
  const pctv = a.status === "done" ? 100 : a.total_conversations ? Math.round((a.processed_conversations / a.total_conversations) * 100) : 0;
  return (
    <div className="flex items-center gap-2 min-w-40">
      <Progress value={a.status === "summarizing" ? 100 : pctv} className="h-2" />
      <span className="text-[11px] text-muted-foreground whitespace-nowrap">{a.processed_conversations}/{a.total_conversations}</span>
    </div>
  );
}

function AnalysisList({ onOpen }: { onOpen: (id: string) => void }) {
  const fn = useServerFn(listAiAnalyses);
  const { data, isLoading } = useQuery({
    queryKey: ["ai-analyses"], queryFn: () => fn(),
    refetchInterval: (q) => ((q.state.data ?? []).some((a) => !["done", "error"].includes(a.status)) ? 10_000 : false),
  });
  return (
    <Card className="p-4 overflow-x-auto">
      <h2 className="font-semibold mb-3">Análises</h2>
      {isLoading ? <p className="text-sm text-muted-foreground">Carregando…</p> : !data?.length ? <p className="text-sm text-muted-foreground">Nenhuma análise ainda.</p> : (
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground"><tr className="text-left border-b border-border">
            <th className="py-2">Criada em</th><th className="py-2">Período</th><th className="py-2">Status</th><th className="py-2">Progresso</th><th className="py-2">Pedida por</th><th />
          </tr></thead>
          <tbody>
            {data.map((a) => (
              <tr key={a.id} className="border-b border-border/60">
                <td className="py-2">{new Date(a.created_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</td>
                <td className="py-2">{d(a.since)} – {d(a.until)}</td>
                <td className="py-2"><span className={`text-xs px-2 py-0.5 rounded-full ${STATUS[a.status].cls}`}>{STATUS[a.status].label}</span></td>
                <td className="py-2"><ProgressCell a={a} /></td>
                <td className="py-2">{a.created_by_name}</td>
                <td className="py-2 text-right"><Button size="sm" variant="outline" onClick={() => onOpen(a.id)}>Abrir</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function ResultView({ id, isAdmin, onBack, onOpen }: { id: string; isAdmin: boolean; onBack: () => void; onOpen: (id: string) => void }) {
  const fn = useServerFn(getAiAnalysis);
  const { data: a, isLoading } = useQuery({
    queryKey: ["ai-analysis", id], queryFn: () => fn({ data: { id } }),
    refetchInterval: (q) => (q.state.data && ["done", "error"].includes(q.state.data.status) ? false : 8_000),
  });
  const saveFn = useServerFn(saveBancoAsQuickReplies);
  const save = useMutation({
    mutationFn: () => saveFn({ data: { id } }),
    onSuccess: (r) => toast.success(`${r.created} respostas rápidas criadas${r.skipped ? ` (${r.skipped} já existiam)` : ""}.`),
    onError: (e: Error) => toast.error(e.message),
  });
  const qc = useQueryClient();
  const redoFn = useServerFn(redoAiAnalysis);
  const redo = useMutation({
    mutationFn: () => redoFn({ data: { id } }),
    onSuccess: (r) => { toast.success("Nova análise iniciada."); qc.invalidateQueries({ queryKey: ["ai-analyses"] }); onOpen(r.id); },
    onError: (e: Error) => toast.error(e.message),
  });
  useEffect(() => { window.scrollTo?.(0, 0); }, [id]);

  const md = a?.result_markdown ?? "";
  const download = () => {
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const el = document.createElement("a");
    el.href = url; el.download = `analise-atendimento-${a ? d(a.since).replace(/\//g, "-") : id}.md`; el.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="no-print flex flex-wrap items-center gap-2 mb-4">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="w-4 h-4 mr-1" /> Voltar</Button>
        {a?.status === "done" && (
          <>
            <Button size="sm" variant="outline" onClick={download}><Download className="w-4 h-4 mr-1" /> Baixar .md</Button>
            <Button size="sm" variant="outline" onClick={() => window.print()}><Printer className="w-4 h-4 mr-1" /> Imprimir / Salvar PDF</Button>
            <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(md).then(() => toast.success("Copiado."))}><Copy className="w-4 h-4 mr-1" /> Copiar</Button>
            {!!a.result_json?.banco?.length && (
              <Button size="sm" variant="outline" onClick={() => save.mutate()} disabled={save.isPending}><MessageSquarePlus className="w-4 h-4 mr-1" /> Salvar banco de respostas como respostas rápidas</Button>
            )}
          </>
        )}
        {isAdmin && a && ["done", "error"].includes(a.status) && (
          <Button size="sm" variant="outline" onClick={() => redo.mutate()} disabled={redo.isPending}><RotateCcw className="w-4 h-4 mr-1" /> Refazer análise</Button>
        )}
      </div>

      {isLoading || !a ? <p className="text-sm text-muted-foreground">Carregando…</p> : a.status !== "done" ? (
        <Card className="p-6 max-w-xl">
          <div className="flex items-center gap-2 mb-3">
            <Badge className={STATUS[a.status].cls}>{STATUS[a.status].label}</Badge>
            <span className="text-sm text-muted-foreground">{d(a.since)} – {d(a.until)}</span>
          </div>
          {a.status === "error" ? <p className="text-sm text-destructive">{a.error}</p> : (
            <>
              <ProgressCell a={a} />
              <p className="text-xs text-muted-foreground mt-3">
                {a.status === "summarizing" ? "Conversas lidas. Escrevendo o documento final…" : "A análise roda em segundo plano; pode fechar esta página."}
                {a.failed_conversations > 0 && ` ${a.failed_conversations} conversas foram puladas após 3 falhas.`}
              </p>
            </>
          )}
        </Card>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[220px_1fr]">
          <nav className="no-print hidden lg:block">
            <div className="sticky top-4 space-y-1 text-sm">
              <div className="text-xs uppercase text-muted-foreground mb-2">Sumário</div>
              {(a.result_json?.sections ?? []).map((s) => (
                <a key={s} href={`#${slug(s)}`} className="block py-1 text-muted-foreground hover:text-foreground">{s}</a>
              ))}
            </div>
          </nav>
          <article className="print-area max-w-3xl">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>{md}</ReactMarkdown>
          </article>
        </div>
      )}
    </div>
  );
}

const text = (c: ReactNode): string => (Array.isArray(c) ? c.map(text).join("") : typeof c === "string" ? c : (c as any)?.props ? text((c as any).props.children) : "");
const MD: any = {
  h1: ({ children }: any) => <h1 className="text-3xl font-bold tracking-tight mb-2">{children}</h1>,
  h2: ({ children }: any) => <h2 id={slug(text(children))} className="scroll-mt-4 text-xl font-semibold mt-10 mb-3 pb-2 border-b border-border">{children}</h2>,
  h3: ({ children }: any) => <h3 className="text-base font-semibold mt-6 mb-2">{children}</h3>,
  p: ({ children }: any) => <p className="leading-7 my-3 text-[15px]">{children}</p>,
  ul: ({ children }: any) => <ul className="list-disc pl-6 my-3 space-y-1.5 text-[15px] leading-7">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal pl-6 my-3 space-y-1.5">{children}</ol>,
  em: ({ children }: any) => <em className="text-muted-foreground">{children}</em>,
  strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
  table: ({ children }: any) => <div className="overflow-x-auto my-4"><table className="w-full text-sm border border-border">{children}</table></div>,
  th: ({ children }: any) => <th className="text-left font-medium bg-muted px-3 py-2 border-b border-border">{children}</th>,
  td: ({ children }: any) => <td className="px-3 py-2 border-b border-border/60 align-top">{children}</td>,
};
