import { createFileRoute, Outlet, redirect, Link, useRouter } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { MessageCircle, BarChart3, Radio, Settings, LogOut, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    // Só quem tem role (criado por um admin) acessa o painel.
    const { data: roles } = await supabase
      .from("user_roles").select("role").eq("user_id", data.user.id);
    const hasAccess = (roles ?? []).length > 0;
    return { user: data.user, hasAccess };
  },
  component: AuthenticatedLayout,
});

function NoAccess({ onLogout }: { onLogout: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-sm text-center space-y-4">
        <h1 className="text-xl font-semibold">Acesso pendente</h1>
        <p className="text-sm text-muted-foreground">
          Sua conta ainda não foi liberada. Peça a um administrador do AttendFlow para
          liberar seu acesso.
        </p>
        <Button variant="outline" onClick={onLogout}>
          <LogOut className="w-4 h-4 mr-2" /> Sair
        </Button>
      </div>
    </div>
  );
}

const navItems = [
  { to: "/atendimento", icon: MessageCircle, label: "Atendimento" },
  { to: "/relatorios", icon: BarChart3, label: "Relatórios" },
  { to: "/analise-ia", icon: Sparkles, label: "Análise com IA" },
  { to: "/canais", icon: Radio, label: "Canais" },
  { to: "/configuracoes", icon: Settings, label: "Config." },
];

function AuthenticatedLayout() {
  const { user, hasAccess } = Route.useRouteContext();
  const router = useRouter();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.navigate({ to: "/auth" });
  };

  if (!hasAccess) return <NoAccess onLogout={handleLogout} />;

  const initials = (user.user_metadata?.name || user.email || "?")
    .split(/\s+/).map((s: string) => s[0]).join("").slice(0, 2).toUpperCase();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <aside className="w-16 bg-sidebar border-r border-sidebar-border flex flex-col items-center py-4 gap-2">
        {navItems.map(({ to, icon: Icon, label }) => (
          <Link
            key={to}
            to={to}
            className="w-12 h-12 flex items-center justify-center rounded-lg text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors group relative"
            activeProps={{ className: "w-12 h-12 flex items-center justify-center rounded-lg bg-sidebar-accent text-primary" }}
            title={label}
          >
            <Icon className="w-5 h-5" />
            <span className="absolute left-full ml-2 px-2 py-1 rounded bg-popover text-popover-foreground text-xs opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50">
              {label}
            </span>
          </Link>
        ))}
        <div className="mt-auto flex flex-col items-center gap-2">
          <Avatar className="w-9 h-9">
            <AvatarFallback className="bg-primary text-primary-foreground text-xs">{initials}</AvatarFallback>
          </Avatar>
          <Button variant="ghost" size="icon" onClick={handleLogout} title="Sair">
            <LogOut className="w-4 h-4" />
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
