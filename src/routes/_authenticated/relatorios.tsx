import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { MessageSquare, Users, Clock, CheckCircle2, TrendingUp, Radio } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid, PieChart, Pie, Cell, Legend } from "recharts";

export const Route = createFileRoute("/_authenticated/relatorios")({
  head: () => ({ meta: [{ title: "Relatórios — AttendFlow" }] }),
  component: RelatoriosPage,
});

const COLORS = ["oklch(0.52 0.13 162)", "oklch(0.65 0.15 220)", "oklch(0.7 0.15 60)", "oklch(0.62 0.2 300)"];

function RelatoriosPage() {
  const { data: stats } = useQuery({
    queryKey: ["report-stats"],
    queryFn: async () => {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const [{ count: convCount }, { count: msgCount }, { count: contactCount }, { data: convs }, { data: msgs }] = await Promise.all([
        supabase.from("conversations").select("*", { count: "exact", head: true }),
        supabase.from("messages").select("*", { count: "exact", head: true }).gte("created_at", since),
        supabase.from("contacts").select("*", { count: "exact", head: true }),
        supabase.from("conversations").select("status, channel_id, channels(type, name)"),
        supabase.from("messages").select("created_at, direction").gte("created_at", since),
      ]);

      const resolved = (convs ?? []).filter((c: any) => c.status === "resolved").length;
      const open = (convs ?? []).filter((c: any) => c.status === "open").length;

      // Daily volume
      const byDay: Record<string, number> = {};
      for (let i = 29; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        byDay[d] = 0;
      }
      (msgs ?? []).forEach((m: any) => {
        const k = m.created_at.slice(0, 10);
        if (k in byDay) byDay[k]++;
      });
      const dailyVolume = Object.entries(byDay).map(([date, count]) => ({
        date: date.slice(5),
        mensagens: count,
      }));

      // Per channel
      const byChannel: Record<string, number> = {};
      (convs ?? []).forEach((c: any) => {
        const k = c.channels?.type ?? "outros";
        byChannel[k] = (byChannel[k] ?? 0) + 1;
      });
      const channelData = Object.entries(byChannel).map(([name, value]) => ({ name, value }));

      return {
        convCount: convCount ?? 0,
        msgCount: msgCount ?? 0,
        contactCount: contactCount ?? 0,
        resolved,
        open,
        dailyVolume,
        channelData,
      };
    },
  });

  const kpis = [
    { label: "Conversas totais", value: stats?.convCount ?? 0, icon: MessageSquare, color: "text-primary" },
    { label: "Mensagens (30d)", value: stats?.msgCount ?? 0, icon: TrendingUp, color: "text-chart-2" },
    { label: "Contatos únicos", value: stats?.contactCount ?? 0, icon: Users, color: "text-chart-3" },
    { label: "Resolvidas", value: stats?.resolved ?? 0, icon: CheckCircle2, color: "text-primary" },
    { label: "Em aberto", value: stats?.open ?? 0, icon: Clock, color: "text-chart-4" },
    { label: "Canais ativos", value: stats?.channelData?.length ?? 0, icon: Radio, color: "text-chart-5" },
  ];

  return (
    <div className="h-full overflow-y-auto p-6 max-w-7xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Relatórios</h1>
        <p className="text-muted-foreground text-sm mt-1">Métricas dos últimos 30 dias.</p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        {kpis.map((k) => (
          <Card key={k.label} className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{k.label}</span>
              <k.icon className={`w-4 h-4 ${k.color}`} />
            </div>
            <div className="text-2xl font-bold mt-2">{k.value}</div>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-4 lg:col-span-2">
          <h3 className="font-semibold mb-4">Volume de mensagens por dia</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={stats?.dailyVolume ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.32 0.012 200)" />
                <XAxis dataKey="date" stroke="oklch(0.68 0.012 200)" tick={{ fontSize: 11 }} />
                <YAxis stroke="oklch(0.68 0.012 200)" tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={{ background: "oklch(0.25 0.012 200)", border: "1px solid oklch(0.32 0.012 200)", borderRadius: 8 }} />
                <Line type="monotone" dataKey="mensagens" stroke="oklch(0.52 0.13 162)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-4">
          <h3 className="font-semibold mb-4">Distribuição por canal</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={stats?.channelData ?? []} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label>
                  {(stats?.channelData ?? []).map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>
    </div>
  );
}
