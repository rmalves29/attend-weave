import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  createCampaign, listCampaigns, getCampaignDetail, setCampaignStatus,
} from "@/lib/campaigns.functions";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription, DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Send, Plus, Play, Pause, Square, Loader2, AlertTriangle, Users } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/campanhas")({
  head: () => ({ meta: [{ title: "Campanhas — AttendFlow" }] }),
  component: CampanhasPage,
});

const STATUS_LABEL: Record<string, string> = {
  draft: "Rascunho", running: "Enviando", paused: "Pausada", done: "Concluída", canceled: "Cancelada",
};
const STATUS_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground", running: "bg-primary text-primary-foreground",
  paused: "bg-amber-500 text-white", done: "bg-emerald-600 text-white", canceled: "bg-destructive text-destructive-foreground",
};

function CampanhasPage() {
  const listFn = useServerFn(listCampaigns);
  const { data: campaigns = [], isLoading } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => listFn(),
    refetchInterval: 15000,
  });
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="h-full overflow-y-auto p-6 max-w-5xl mx-auto">
      <header className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Campanhas</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Disparo em lista com ritmo controlado. Use um chip separado — não o número de atendimento.
          </p>
        </div>
        <NewCampaignDialog />
      </header>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : campaigns.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          Nenhuma campanha ainda. Crie a primeira no botão acima.
        </Card>
      ) : (
        <div className="space-y-3">
          {campaigns.map((c: any) => {
            const done = (c.sent_count ?? 0) + (c.failed_count ?? 0);
            const pct = c.total ? Math.round((done / c.total) * 100) : 0;
            return (
              <Card key={c.id} className="p-4 cursor-pointer hover:bg-accent/40" onClick={() => setSelected(c.id)}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{c.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {c.channels?.name ?? "—"} · {c.daily_cap}/dia · 1 a cada {c.interval_minutes} min · {c.window_start}h–{c.window_end}h
                    </div>
                  </div>
                  <Badge className={STATUS_TONE[c.status] ?? ""}>{STATUS_LABEL[c.status] ?? c.status}</Badge>
                </div>
                <div className="mt-3">
                  <Progress value={pct} />
                  <div className="text-xs text-muted-foreground mt-1">
                    {c.sent_count}/{c.total} enviados{c.failed_count ? ` · ${c.failed_count} falhas` : ""}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <CampaignDetailDialog id={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function NewCampaignDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [channelId, setChannelId] = useState<string>("");
  const [message, setMessage] = useState("");
  const [recipientsRaw, setRecipientsRaw] = useState("");
  const [dailyCap, setDailyCap] = useState(50);
  const [intervalMinutes, setIntervalMinutes] = useState(5);

  const { data: channels = [] } = useQuery({
    queryKey: ["campaign-channels"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("channels").select("id, name, type, status").eq("type", "whatsapp").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const lineCount = useMemo(
    () => recipientsRaw.split(/\r?\n/).filter((l) => l.trim()).length,
    [recipientsRaw],
  );

  const createFn = useServerFn(createCampaign);
  const mutation = useMutation({
    mutationFn: () => createFn({ data: {
      name: name.trim(), channelId, message: message.trim(), recipientsRaw,
      dailyCap, intervalMinutes,
    } }),
    onSuccess: (r) => {
      toast.success(`Campanha criada: ${r.total} contatos${r.duplicates ? `, ${r.duplicates} duplicados removidos` : ""}${r.invalid ? `, ${r.invalid} inválidos` : ""}. Inicie na campanha.`);
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      setOpen(false);
      setName(""); setMessage(""); setRecipientsRaw(""); setChannelId("");
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao criar"),
  });

  const selectedChannel = channels.find((c: any) => c.id === channelId);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button><Plus className="w-4 h-4 mr-2" /> Nova campanha</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nova campanha</DialogTitle>
          <DialogDescription>
            Dispara a mensagem para a lista, no ritmo definido. Use <strong>{"{nome}"}</strong> para
            personalizar. Comece com um chip separado do atendimento.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Nome da campanha</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Prospecção Cartzy — out/26" />
          </div>
          <div>
            <Label>Chip (canal WhatsApp)</Label>
            <Select value={channelId} onValueChange={setChannelId}>
              <SelectTrigger><SelectValue placeholder="Selecione o número que vai disparar" /></SelectTrigger>
              <SelectContent>
                {channels.map((c: any) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} {c.status === "connected" ? "🟢" : "🔴"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedChannel && selectedChannel.status !== "connected" && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> Esse canal está desconectado — conecte antes de iniciar.
              </p>
            )}
          </div>
          <div>
            <Label>Mensagem</Label>
            <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={6} placeholder="Oi {nome}! Tudo bem?…" />
          </div>
          <div>
            <Label>Lista de telefones <span className="text-muted-foreground font-normal">({lineCount} linhas)</span></Label>
            <Textarea value={recipientsRaw} onChange={(e) => setRecipientsRaw(e.target.value)} rows={6}
              placeholder={"Um por linha. Ex:\n5531999999999\n5531988888888, Maria"} className="font-mono text-xs" />
            <p className="text-xs text-muted-foreground mt-1">Um por linha. Pode ser só o telefone, ou "telefone, nome".</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Por dia</Label>
              <Input type="number" min={1} max={1000} value={dailyCap} onChange={(e) => setDailyCap(Number(e.target.value))} />
            </div>
            <div>
              <Label>Intervalo (min)</Label>
              <Input type="number" min={1} max={240} value={intervalMinutes} onChange={(e) => setIntervalMinutes(Number(e.target.value))} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
          <Button
            disabled={!name.trim() || !channelId || !message.trim() || !recipientsRaw.trim() || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Criar campanha
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CampaignDetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const detailFn = useServerFn(getCampaignDetail);
  const statusFn = useServerFn(setCampaignStatus);
  const { data } = useQuery({
    queryKey: ["campaign-detail", id],
    queryFn: () => detailFn({ data: { id: id! } }),
    enabled: !!id,
    refetchInterval: 10000,
  });

  const statusMutation = useMutation({
    mutationFn: (action: "start" | "pause" | "resume" | "cancel") => statusFn({ data: { id: id!, action } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      qc.invalidateQueries({ queryKey: ["campaign-detail", id] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha"),
  });

  const c = (data as any)?.campaign;
  const done = c ? (c.sent_count ?? 0) + (c.failed_count ?? 0) : 0;
  const pct = c?.total ? Math.round((done / c.total) * 100) : 0;
  const connected = c?.channels?.status === "connected";

  return (
    <Dialog open={!!id} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        {!c ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Carregando…</div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Send className="w-4 h-4" /> {c.name}
              </DialogTitle>
              <DialogDescription>
                {c.channels?.name} · {c.daily_cap}/dia · 1 a cada {c.interval_minutes} min · janela {c.window_start}h–{c.window_end}h
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <Badge className={STATUS_TONE[c.status] ?? ""}>{STATUS_LABEL[c.status] ?? c.status}</Badge>
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Users className="w-3 h-3" /> {c.total} contatos
                  </span>
                </div>
                <Progress value={pct} />
                <div className="text-xs text-muted-foreground mt-1">
                  {c.sent_count} enviados · {(data as any).pending} pendentes{c.failed_count ? ` · ${c.failed_count} falhas` : ""}
                </div>
              </div>

              {c.status === "paused" && c.consecutive_failures >= 5 && (
                <p className="text-xs text-destructive flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> Pausada automaticamente após várias falhas seguidas — o chip pode estar desconectado ou bloqueado.
                </p>
              )}
              {c.status === "running" && !connected && (
                <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> O chip está desconectado — os envios vão falhar até reconectar.
                </p>
              )}

              <div className="rounded-lg border border-border p-3 bg-muted/30">
                <div className="text-xs text-muted-foreground mb-1">Mensagem</div>
                <div className="text-sm whitespace-pre-wrap">{c.message_template}</div>
              </div>

              {(data as any).recentFailed?.length > 0 && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Falhas recentes</div>
                  <div className="space-y-1">
                    {(data as any).recentFailed.map((f: any, i: number) => (
                      <div key={i} className="text-xs flex justify-between gap-2">
                        <span className="font-mono">{f.phone}</span>
                        <span className="text-destructive truncate">{f.error}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <DialogFooter className="gap-2">
              {(c.status === "draft" || c.status === "paused") && (
                <Button onClick={() => statusMutation.mutate(c.status === "draft" ? "start" : "resume")} disabled={statusMutation.isPending}>
                  <Play className="w-4 h-4 mr-2" /> {c.status === "draft" ? "Iniciar" : "Retomar"}
                </Button>
              )}
              {c.status === "running" && (
                <Button variant="secondary" onClick={() => statusMutation.mutate("pause")} disabled={statusMutation.isPending}>
                  <Pause className="w-4 h-4 mr-2" /> Pausar
                </Button>
              )}
              {["draft", "running", "paused"].includes(c.status) && (
                <Button variant="ghost" className="text-destructive" onClick={() => statusMutation.mutate("cancel")} disabled={statusMutation.isPending}>
                  <Square className="w-4 h-4 mr-2" /> Cancelar
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
