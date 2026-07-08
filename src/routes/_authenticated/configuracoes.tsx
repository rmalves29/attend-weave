import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Zap, Trash2, Plus } from "lucide-react";
import { toast } from "sonner";

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

      <QuickRepliesCard />
    </div>
  );
}

function QuickRepliesCard() {
  const qc = useQueryClient();
  const [shortcut, setShortcut] = useState("");
  const [content, setContent] = useState("");

  const { data: replies = [] } = useQuery({
    queryKey: ["quick-replies"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("quick_replies" as any).select("id, shortcut, content").order("shortcut");
      if (error) throw error;
      return (data ?? []) as unknown as { id: string; shortcut: string; content: string }[];
    },
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      const s = shortcut.trim().toLowerCase().replace(/^\//, "").replace(/\s+/g, "-");
      const c = content.trim();
      if (!s || !c) throw new Error("Preencha atalho e mensagem");
      const { data: u } = await supabase.auth.getUser();
      const { error } = await supabase.from("quick_replies" as any)
        .insert({ shortcut: s, content: c, created_by: u.user?.id ?? null });
      if (error) throw new Error(error.code === "23505" ? `O atalho /${s} já existe` : error.message);
    },
    onSuccess: () => {
      setShortcut(""); setContent("");
      toast.success("Resposta rápida criada");
      qc.invalidateQueries({ queryKey: ["quick-replies"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao criar"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("quick_replies" as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["quick-replies"] }),
    onError: (e: any) => toast.error(e?.message ?? "Falha ao remover"),
  });

  return (
    <Card className="p-5 mt-6">
      <h2 className="font-semibold mb-1 flex items-center gap-2">
        <Zap className="w-4 h-4 text-primary" /> Respostas rápidas
      </h2>
      <p className="text-xs text-muted-foreground mb-4">
        No atendimento, digite <code className="bg-muted px-1 rounded">/atalho</code> para inserir a mensagem pronta.
        Variáveis não são substituídas — escreva o texto exatamente como deve sair.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr_auto] gap-2 mb-4">
        <Input
          value={shortcut}
          onChange={(e) => setShortcut(e.target.value)}
          placeholder="atalho (ex: frete)"
          maxLength={30}
        />
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Mensagem completa que será inserida"
          rows={2}
          className="min-h-9"
        />
        <Button
          type="button"
          onClick={() => addMutation.mutate()}
          disabled={addMutation.isPending || !shortcut.trim() || !content.trim()}
          className="sm:self-start"
        >
          <Plus className="w-4 h-4 mr-1" /> Adicionar
        </Button>
      </div>

      <div className="space-y-2">
        {replies.length === 0 && (
          <div className="text-sm text-muted-foreground py-4 text-center">
            Nenhuma resposta rápida ainda. Crie a primeira — ex: <code className="bg-muted px-1 rounded">/pix</code> com a chave da loja.
          </div>
        )}
        {replies.map((r) => (
          <div key={r.id} className="flex items-start gap-3 p-2 rounded-lg hover:bg-accent group">
            <code className="text-primary text-sm font-mono shrink-0 pt-0.5">/{r.shortcut}</code>
            <div className="flex-1 text-sm text-muted-foreground whitespace-pre-wrap break-words">{r.content}</div>
            <Button
              type="button" variant="ghost" size="icon"
              className="h-7 w-7 opacity-0 group-hover:opacity-100 text-destructive"
              onClick={() => deleteMutation.mutate(r.id)}
              disabled={deleteMutation.isPending}
              title="Remover"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}
