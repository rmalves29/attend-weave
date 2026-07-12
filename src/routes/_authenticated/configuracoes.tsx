import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { createUser } from "@/lib/users.functions";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Zap, Trash2, Plus, Users, UserPlus, Tag, Clock, Contact, Search } from "lucide-react";
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

      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users" className="gap-2">
            <Users className="w-4 h-4" /> Usuários
          </TabsTrigger>
          <TabsTrigger value="quick-replies" className="gap-2">
            <Zap className="w-4 h-4" /> Respostas rápidas
          </TabsTrigger>
          <TabsTrigger value="tags" className="gap-2">
            <Tag className="w-4 h-4" /> Etiquetas
          </TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="mt-4">
          <UsersSection currentUserId={user.id} />
        </TabsContent>

        <TabsContent value="quick-replies" className="mt-4">
          <QuickRepliesCard />
        </TabsContent>

        <TabsContent value="tags" className="mt-4">
          <TagsManagementCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function UsersSection({ currentUserId }: { currentUserId: string }) {
  const qc = useQueryClient();
  const createUserFn = useServerFn(createUser);

  const { data: currentRoles = [] } = useQuery({
    queryKey: ["my-roles", currentUserId],
    queryFn: async () => {
      const { data } = await supabase.from("user_roles").select("role").eq("user_id", currentUserId);
      return (data ?? []).map((r: any) => r.role as string);
    },
  });
  const isAdmin = currentRoles.includes("admin");

  const { data: agents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("*, user_roles(role)");
      return data ?? [];
    },
  });

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "agent">("agent");

  const createMut = useMutation({
    mutationFn: async () => {
      await createUserFn({ data: { name: name.trim(), email: email.trim(), password, role } });
    },
    onSuccess: () => {
      setName(""); setEmail(""); setPassword(""); setRole("agent");
      toast.success("Usuário criado");
      qc.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao criar usuário"),
  });

  const canSubmit = isAdmin && name.trim().length >= 2 && /.+@.+\..+/.test(email) && password.length >= 8;

  return (
    <>
      <Card className="p-5 mb-6">
        <h2 className="font-semibold mb-1 flex items-center gap-2">
          <UserPlus className="w-4 h-4 text-primary" /> Cadastrar novo usuário
        </h2>
        <p className="text-xs text-muted-foreground mb-4">
          {isAdmin
            ? "Cria a conta já confirmada. O usuário poderá entrar imediatamente com o e-mail e senha definidos."
            : "Apenas administradores podem cadastrar novos usuários."}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Nome" disabled={!isAdmin} maxLength={80}
          />
          <Input
            value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="email@exemplo.com" type="email" disabled={!isAdmin} maxLength={255}
          />
          <Input
            value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="Senha (mín. 8 caracteres)" type="password" disabled={!isAdmin}
          />
          <Select value={role} onValueChange={(v) => setRole(v as "admin" | "agent")} disabled={!isAdmin}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="agent">Atendente</SelectItem>
              <SelectItem value="admin">Administrador</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex justify-end mt-4">
          <Button
            type="button"
            onClick={() => createMut.mutate()}
            disabled={!canSubmit || createMut.isPending}
          >
            <Plus className="w-4 h-4 mr-1" />
            {createMut.isPending ? "Criando…" : "Cadastrar"}
          </Button>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold mb-4">Usuários cadastrados ({agents.length})</h2>
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
    </>
  );
}

const TAG_STATUS_OPTIONS = [
  { value: "none", label: "Não muda o status" },
  { value: "open", label: "Aberta" },
  { value: "pending", label: "Aguardando" },
  { value: "resolved", label: "Finalizada" },
  { value: "closed", label: "Fechada" },
];

function TagsManagementCard() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [setsStatus, setSetsStatus] = useState("none");
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoHours, setAutoHours] = useState(24);
  const [autoContent, setAutoContent] = useState("");

  const { data: tags = [] } = useQuery({
    queryKey: ["tags"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tags" as any)
        .select("id, name, sets_status, auto_message_enabled, auto_message_hours, auto_message_content")
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as {
        id: string; name: string; sets_status: string | null;
        auto_message_enabled: boolean; auto_message_hours: number; auto_message_content: string | null;
      }[];
    },
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      const n = name.trim().toLowerCase();
      if (!n) throw new Error("Dê um nome à etiqueta");
      if (autoEnabled && !autoContent.trim()) throw new Error("Escreva a mensagem automática");
      const { error } = await supabase.from("tags" as any).insert({
        name: n,
        sets_status: setsStatus === "none" ? null : setsStatus,
        auto_message_enabled: autoEnabled,
        auto_message_hours: Math.min(720, Math.max(1, autoHours || 24)),
        auto_message_content: autoEnabled ? autoContent.trim() : null,
      });
      if (error) throw new Error(error.code === "23505" ? `A etiqueta "${n}" já existe` : error.message);
    },
    onSuccess: () => {
      setName(""); setSetsStatus("none"); setAutoEnabled(false); setAutoHours(24); setAutoContent("");
      toast.success("Etiqueta criada");
      qc.invalidateQueries({ queryKey: ["tags"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao criar etiqueta"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("tags" as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Etiqueta removida");
      qc.invalidateQueries({ queryKey: ["tags"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao remover"),
  });

  const statusLabel = (v: string | null) =>
    TAG_STATUS_OPTIONS.find((o) => o.value === (v ?? "none"))?.label ?? v;

  return (
    <Card className="p-5 mt-6">
      <h2 className="font-semibold mb-1 flex items-center gap-2">
        <Tag className="w-4 h-4 text-primary" /> Etiquetas
      </h2>
      <p className="text-xs text-muted-foreground mb-4">
        As atendentes só podem usar etiquetas desta lista. Cada etiqueta pode mudar o status da conversa
        e agendar uma mensagem automática pro cliente (cancelada se ele responder antes).
      </p>

      {/* Formulário de nova etiqueta */}
      <div className="rounded-lg border p-3 mb-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Nome da etiqueta (ex: aguardando)" maxLength={40} />
          <Select value={setsStatus} onValueChange={setSetsStatus}>
            <SelectTrigger><SelectValue placeholder="Muda o status?" /></SelectTrigger>
            <SelectContent>
              {TAG_STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2">
          <div className="text-sm flex items-center gap-2">
            <Clock className="w-4 h-4 text-muted-foreground" />
            Enviar mensagem automática se o cliente não responder
          </div>
          <Switch checked={autoEnabled} onCheckedChange={setAutoEnabled} />
        </div>

        {autoEnabled && (
          <div className="space-y-2 pl-1">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Enviar após</span>
              <Input type="number" min={1} max={720} value={autoHours}
                onChange={(e) => setAutoHours(Number(e.target.value))}
                className="w-20 h-8" />
              <span className="text-muted-foreground">horas sem resposta</span>
            </div>
            <Textarea
              value={autoContent}
              onChange={(e) => setAutoContent(e.target.value)}
              placeholder={"Mensagem que o cliente vai receber.\nEx: Oi! Passando para saber se você ainda precisa de ajuda 😊"}
              rows={3}
            />
          </div>
        )}

        <div className="flex justify-end">
          <Button type="button" onClick={() => addMutation.mutate()}
            disabled={addMutation.isPending || !name.trim()}>
            <Plus className="w-4 h-4 mr-1" /> Criar etiqueta
          </Button>
        </div>
      </div>

      {/* Lista */}
      <div className="space-y-2">
        {tags.length === 0 && (
          <div className="text-sm text-muted-foreground py-4 text-center">Nenhuma etiqueta cadastrada.</div>
        )}
        {tags.map((t) => (
          <div key={t.id} className="flex items-start gap-3 p-2 rounded-lg hover:bg-accent group">
            <Badge variant="secondary" className="shrink-0">{t.name}</Badge>
            <div className="flex-1 text-xs text-muted-foreground space-y-0.5">
              <div>Status: {statusLabel(t.sets_status)}</div>
              {t.auto_message_enabled && (
                <div className="flex items-start gap-1">
                  <Clock className="w-3 h-3 mt-0.5 shrink-0" />
                  <span>Em {t.auto_message_hours}h: “{t.auto_message_content}”</span>
                </div>
              )}
            </div>
            <Button
              type="button" variant="ghost" size="icon"
              className="h-7 w-7 opacity-0 group-hover:opacity-100 text-destructive shrink-0"
              onClick={() => deleteMutation.mutate(t.id)}
              disabled={deleteMutation.isPending}
              title="Remover etiqueta"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        ))}
      </div>
    </Card>
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
    <Card className="p-5">
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
