import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { MessageCircle, Instagram, Facebook, Plus, QrCode, Trash2, Loader2, RefreshCw, Power, Download } from "lucide-react";
import { toast } from "sonner";
import {
  createUazapiInstance, connectUazapiInstance, getUazapiStatus,
  disconnectUazapiInstance, deleteUazapiInstance, syncUazapiHistory,
} from "@/lib/uazapi.functions";

async function runFullSync(channelId: string, syncFn: any) {
  toast.info("Sincronizando histórico completo… isso pode levar alguns minutos.");
  let total = 0;
  try {
    for (let i = 0; i < 40; i++) {
      const r = await syncFn({ data: { channelId, perChatLimit: 10000 } });
      total = r.ingested ?? total;
      if (!r.partial) {
        toast.success(`Histórico sincronizado: ${r.ingested} mensagens em ${r.chats} conversas`);
        return;
      }
    }
    toast.success(`Sincronização parcial concluída: ${total} mensagens (execute novamente para continuar)`);
  } catch (e: any) {
    toast.error(e?.message ?? "Falha ao sincronizar histórico");
  }
}

export const Route = createFileRoute("/_authenticated/canais")({
  head: () => ({ meta: [{ title: "Canais — AttendFlow" }] }),
  component: CanaisPage,
});

const iconFor = (type: string) => {
  if (type === "instagram") return Instagram;
  if (type === "facebook") return Facebook;
  return MessageCircle;
};

const statusColor = (s: string) => ({
  connected: "bg-primary/20 text-primary",
  disconnected: "bg-muted text-muted-foreground",
  connecting: "bg-chart-3/20 text-chart-3",
  error: "bg-destructive/20 text-destructive",
}[s] ?? "bg-muted");

const statusLabel = (s: string) => ({
  connected: "Conectado",
  disconnected: "Desconectado",
  connecting: "Conectando",
  error: "Erro",
}[s] ?? s);

function CanaisPage() {
  const qc = useQueryClient();
  const [newOpen, setNewOpen] = useState(false);
  const [qrChannel, setQrChannel] = useState<any | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data: channels = [] } = useQuery({
    queryKey: ["channels"],
    queryFn: async () => {
      const { data, error } = await supabase.from("channels").select("id,name,type,identifier,status,qr_code,last_connected_at,created_at,updated_at").order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 5000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["channels"] });

  return (
    <div className="h-full overflow-y-auto p-6 max-w-5xl mx-auto">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Canais</h1>
          <p className="text-muted-foreground text-sm mt-1">Conecte quantas instâncias WhatsApp precisar via uazapi.</p>
        </div>
        <Button onClick={() => setNewOpen(true)}>
          <Plus className="w-4 h-4 mr-2" /> Nova instância
        </Button>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {channels.length === 0 && (
          <Card className="col-span-full p-8 text-center text-muted-foreground">
            Nenhuma instância criada. Clique em <b>Nova instância</b> para começar.
          </Card>
        )}
        {channels.map((c: any) => (
          <ChannelCard
            key={c.id}
            channel={c}
            onConnect={() => setQrChannel(c)}
            onDelete={() => setDeleteId(c.id)}
            onChanged={invalidate}
          />
        ))}
      </div>

      <NewInstanceDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={(channelId: string) => {
          invalidate();
          setTimeout(async () => {
            const { data } = await supabase.from("channels").select("id,name,type,identifier,status,qr_code,last_connected_at,created_at,updated_at").eq("id", channelId).single();
            if (data) setQrChannel(data);
          }, 300);
        }}
      />

      <QrDialog
        channel={qrChannel}
        onOpenChange={(o: boolean) => { if (!o) setQrChannel(null); invalidate(); }}
      />

      <DeleteDialog
        channelId={deleteId}
        onOpenChange={(o: boolean) => !o && setDeleteId(null)}
        onDeleted={invalidate}
      />
    </div>
  );
}

function ChannelCard({ channel, onConnect, onDelete, onChanged }: any) {
  const Icon = iconFor(channel.type);
  const disconnectFn = useServerFn(disconnectUazapiInstance);
  const statusFn = useServerFn(getUazapiStatus);

  const [busy, setBusy] = useState(false);

  const handleDisconnect = async () => {
    setBusy(true);
    try {
      await disconnectFn({ data: { channelId: channel.id } });
      toast.success("Desconectado");
      onChanged();
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  };
  const handleRefresh = async () => {
    setBusy(true);
    try {
      await statusFn({ data: { channelId: channel.id } });
      onChanged();
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
          <Icon className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{channel.name}</div>
          <div className="text-xs text-muted-foreground truncate">{channel.identifier ?? "—"}</div>
        </div>
        <Badge className={statusColor(channel.status)}>{statusLabel(channel.status)}</Badge>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {channel.status !== "connected" ? (
          <Button variant="outline" size="sm" className="flex-1 min-w-[120px]" onClick={onConnect} disabled={busy}>
            <QrCode className="w-4 h-4 mr-2" /> Conectar
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="flex-1 min-w-[120px]" onClick={handleDisconnect} disabled={busy}>
            <Power className="w-4 h-4 mr-2" /> Desconectar
          </Button>
        )}
        <Button variant="ghost" size="icon" onClick={handleRefresh} disabled={busy} title="Atualizar status">
          <RefreshCw className={`w-4 h-4 ${busy ? "animate-spin" : ""}`} />
        </Button>
        <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive" onClick={onDelete} title="Excluir">
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    </Card>
  );
}

function NewInstanceDialog({ open, onOpenChange, onCreated }: any) {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const createFn = useServerFn(createUazapiInstance);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    try {
      const res = await createFn({ data: { name: name.trim() } });
      toast.success("Instância criada");
      setName("");
      onOpenChange(false);
      onCreated(res.channelId);
    } catch (e: any) { toast.error(e.message); }
    finally { setLoading(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nova instância WhatsApp</DialogTitle>
          <DialogDescription>Dê um nome para identificar essa instância (ex: "Vendas", "Suporte").</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="inst-name">Nome</Label>
            <Input id="inst-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Vendas" autoFocus />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button type="submit" disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Criar e conectar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function QrDialog({ channel, onOpenChange }: any) {
  const connectFn = useServerFn(connectUazapiInstance);
  const statusFn = useServerFn(getUazapiStatus);
  const syncFn = useServerFn(syncUazapiHistory);
  const [qr, setQr] = useState<string | null>(null);
  const [status, setStatus] = useState<string>(channel?.status ?? "disconnected");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!channel) { setQr(null); return; }
    setStatus(channel.status);
    setQr(channel.qr_code ?? null);
    let cancelled = false;
    let syncStarted = false;
    const triggerFullSync = async () => {
      if (syncStarted) return;
      syncStarted = true;
      toast.info("Carregando histórico completo do número. Isso pode levar alguns minutos…");
      try {
        // Roda em rajadas até esgotar — a função retorna parcial quando
        // atinge o orçamento de tempo; nesse caso, chama de novo.
        for (let i = 0; i < 20; i++) {
          const r = await syncFn({ data: { channelId: channel.id, perChatLimit: 10000 } });
          if (!r.partial) { toast.success(`Histórico sincronizado: ${r.ingested} mensagens`); break; }
          if (cancelled) return;
        }
      } catch (e: any) {
        toast.error(e?.message ?? "Falha ao sincronizar histórico");
      }
    };
    (async () => {
      setLoading(true);
      try {
        const r = await connectFn({ data: { channelId: channel.id } });
        if (cancelled) return;
        if (r.qr) setQr(r.qr);
        setStatus(r.status ?? "connecting");
        if (r.status === "connected") { void triggerFullSync(); }
      } catch (e: any) { toast.error(e.message); }
      finally { setLoading(false); }
    })();
    const interval = setInterval(async () => {
      try {
        const r = await statusFn({ data: { channelId: channel.id } });
        if (cancelled) return;
        setStatus(r.status);
        if (r.status === "connected") {
          clearInterval(interval);
          toast.success("WhatsApp conectado!");
          void triggerFullSync();
          onOpenChange(false);
        }
      } catch {}
    }, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [channel?.id]);

  const qrSrc = qr ? (qr.startsWith("data:") ? qr : `data:image/png;base64,${qr}`) : null;

  return (
    <Dialog open={!!channel} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Conectar {channel?.name}</DialogTitle>
          <DialogDescription>
            Abra o WhatsApp no celular → Aparelhos conectados → Conectar um aparelho, e escaneie o QR abaixo.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-4">
          {loading && !qrSrc && <Loader2 className="w-8 h-8 animate-spin text-primary" />}
          {qrSrc && (
            <div className="p-3 bg-white rounded-lg">
              <img src={qrSrc} alt="QR Code" className="w-64 h-64" />
            </div>
          )}
          <Badge className={statusColor(status)}>{statusLabel(status)}</Badge>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ channelId, onOpenChange, onDeleted }: any) {
  const deleteFn = useServerFn(deleteUazapiInstance);
  const [loading, setLoading] = useState(false);
  const handle = async () => {
    if (!channelId) return;
    setLoading(true);
    try {
      await deleteFn({ data: { channelId } });
      toast.success("Instância excluída");
      onDeleted();
      onOpenChange(false);
    } catch (e: any) { toast.error(e.message); }
    finally { setLoading(false); }
  };
  return (
    <AlertDialog open={!!channelId} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Excluir instância?</AlertDialogTitle>
          <AlertDialogDescription>
            Isso desconecta o WhatsApp, remove a instância na uazapi e apaga todas as conversas vinculadas. Não é reversível.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={handle} disabled={loading} className="bg-destructive hover:bg-destructive/90">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Excluir"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
