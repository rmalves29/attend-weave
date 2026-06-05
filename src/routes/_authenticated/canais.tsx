import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MessageCircle, Instagram, Facebook, Plus, QrCode } from "lucide-react";
import { toast } from "sonner";

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

function CanaisPage() {
  const { data: channels = [] } = useQuery({
    queryKey: ["channels"],
    queryFn: async () => {
      const { data, error } = await supabase.from("channels").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  return (
    <div className="h-full overflow-y-auto p-6 max-w-5xl mx-auto">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Canais</h1>
          <p className="text-muted-foreground text-sm mt-1">Gerencie suas conexões de WhatsApp, Instagram e Facebook.</p>
        </div>
        <Button onClick={() => toast.info("Conecte uma instância Evolution API ou Meta nas próximas atualizações.")}>
          <Plus className="w-4 h-4 mr-2" /> Novo canal
        </Button>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {channels.length === 0 && (
          <Card className="col-span-full p-8 text-center text-muted-foreground">
            Nenhum canal cadastrado ainda.
          </Card>
        )}
        {channels.map((c: any) => {
          const Icon = iconFor(c.type);
          return (
            <Card key={c.id} className="p-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                  <Icon className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{c.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{c.identifier ?? "—"}</div>
                </div>
                <Badge className={statusColor(c.status)}>{c.status}</Badge>
              </div>
              <div className="mt-4 flex gap-2">
                <Button variant="outline" size="sm" className="flex-1">
                  <QrCode className="w-4 h-4 mr-2" /> QR Code
                </Button>
                <Button variant="ghost" size="sm" onClick={() => toast.info("Em breve.")}>Desconectar</Button>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
