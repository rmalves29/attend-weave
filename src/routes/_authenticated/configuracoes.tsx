import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/configuracoes")({
  head: () => ({ meta: [{ title: "Configurações — AttendFlow" }] }),
  component: ConfigPage,
});

function ConfigPage() {
  const { user } = Route.useRouteContext();

  const { data: profile } = useQuery({
    queryKey: ["profile", user.id],
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("*").eq("id", user.id).single();
      return data;
    },
  });

  const { data: agents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("*, user_roles(role)");
      return data ?? [];
    },
  });

  return (
    <div className="h-full overflow-y-auto p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Configurações</h1>

      <Card className="p-5 mb-6">
        <h2 className="font-semibold mb-4">Meu perfil</h2>
        <div className="flex items-center gap-4">
          <Avatar className="w-16 h-16">
            <AvatarFallback className="bg-primary/20 text-primary text-xl">
              {profile?.name?.[0]?.toUpperCase() ?? "?"}
            </AvatarFallback>
          </Avatar>
          <div>
            <div className="font-medium text-lg">{profile?.name}</div>
            <div className="text-sm text-muted-foreground">{profile?.email}</div>
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold mb-4">Atendentes ({agents.length})</h2>
        <div className="space-y-2">
          {agents.map((a: any) => (
            <div key={a.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-accent">
              <Avatar className="w-9 h-9">
                <AvatarFallback className="bg-primary/20 text-primary text-xs">
                  {a.name?.[0]?.toUpperCase() ?? "?"}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1">
                <div className="font-medium text-sm">{a.name}</div>
                <div className="text-xs text-muted-foreground">{a.email}</div>
              </div>
              {a.user_roles?.map((r: any) => (
                <Badge key={r.role} variant="secondary" className="capitalize">{r.role}</Badge>
              ))}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
