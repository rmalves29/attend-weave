import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeMessages } from "@/hooks/useRealtimeMessages";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, Send, Smile, Paperclip, Phone, Mail, Tag, MessageCircle, Instagram, Facebook, Check, CheckCheck, RefreshCw } from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { ptBR } from "date-fns/locale";

export const Route = createFileRoute("/_authenticated/atendimento")({
  head: () => ({ meta: [{ title: "Atendimento — AttendFlow" }] }),
  component: AtendimentoPage,
});

type Conversation = {
  id: string;
  contact_id: string;
  channel_id: string;
  assigned_agent_id: string | null;
  status: "open" | "pending" | "resolved" | "closed";
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
  tags: string[];
  contacts: { id: string; name: string; phone: string | null; email: string | null; avatar_url: string | null };
  channels: { id: string; name: string; type: "whatsapp" | "instagram" | "facebook" };
};

type Message = {
  id: string;
  conversation_id: string;
  sender_agent_id: string | null;
  direction: "inbound" | "outbound";
  type: string;
  content: string | null;
  status: string;
  created_at: string;
};

const channelIcon = (type: string) => {
  if (type === "instagram") return <Instagram className="w-3 h-3" />;
  if (type === "facebook") return <Facebook className="w-3 h-3" />;
  return <MessageCircle className="w-3 h-3" />;
};

function AtendimentoPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "open" | "pending" | "resolved">("all");

  const qc = useQueryClient();
  useRealtimeMessages(selectedId);

  const { data: conversations = [], isFetching: isFetchingConvs, refetch: refetchConvs } = useQuery({
    queryKey: ["conversations"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select("*, contacts(*), channels(*)")
        .order("last_message_at", { ascending: false, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as unknown as Conversation[];
    },
    refetchInterval: 10000,
    refetchOnWindowFocus: true,
  });

  const handleRefresh = () => {
    refetchConvs();
    if (selectedId) qc.invalidateQueries({ queryKey: ["messages", selectedId] });
  };

  const filtered = useMemo(() => {
    return conversations.filter((c) => {
      if (filter !== "all" && c.status !== filter) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return c.contacts?.name?.toLowerCase().includes(q) || c.last_message_preview?.toLowerCase().includes(q);
    });
  }, [conversations, search, filter]);

  const selected = conversations.find((c) => c.id === selectedId);

  return (
    <div className="flex h-full">
      {/* Coluna 1: lista de conversas */}
      <div className="w-80 border-r border-border bg-sidebar flex flex-col">
        <div className="p-3 border-b border-border">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-lg">Conversas</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleRefresh}
            title="Atualizar"
            className="h-8 w-8"
          >
            <RefreshCw className={`w-4 h-4 ${isFetchingConvs ? "animate-spin" : ""}`} />
          </Button>
        </div>
        <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Pesquisar..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 bg-input border-0"
            />
          </div>
          <div className="flex gap-1 mt-3 text-xs">
            {(["all", "open", "pending", "resolved"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1 rounded-full transition-colors ${
                  filter === f ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"
                }`}
              >
                {f === "all" ? "Todos" : f === "open" ? "Abertos" : f === "pending" ? "Pendentes" : "Resolvidos"}
              </button>
            ))}
          </div>
        </div>
        <ScrollArea className="flex-1">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              Nenhuma conversa encontrada.
            </div>
          ) : (
            filtered.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className={`w-full text-left px-3 py-3 flex gap-3 border-b border-border/50 hover:bg-accent transition-colors ${
                  selectedId === c.id ? "bg-accent" : ""
                }`}
              >
                <Avatar className="w-12 h-12 flex-shrink-0">
                  <AvatarFallback className="bg-primary/20 text-primary">
                    {c.contacts?.name?.[0]?.toUpperCase() ?? "?"}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-center gap-2">
                    <span className="font-medium truncate">{c.contacts?.name}</span>
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                      {c.last_message_at ? format(new Date(c.last_message_at), "HH:mm") : ""}
                    </span>
                  </div>
                  <div className="flex justify-between items-center gap-2 mt-0.5">
                    <span className="text-sm text-muted-foreground truncate flex items-center gap-1">
                      {channelIcon(c.channels?.type)} {c.last_message_preview ?? "—"}
                    </span>
                    {c.unread_count > 0 && (
                      <Badge className="bg-primary text-primary-foreground h-5 min-w-5 px-1.5 rounded-full text-xs">
                        {c.unread_count}
                      </Badge>
                    )}
                  </div>
                </div>
              </button>
            ))
          )}
        </ScrollArea>
      </div>

      {/* Coluna 2: chat */}
      {selected ? (
        <ChatWindow conversation={selected} />
      ) : (
        <div className="flex-1 flex items-center justify-center bg-[var(--chat-bg)] text-muted-foreground">
          <div className="text-center max-w-md p-6">
            <MessageCircle className="w-16 h-16 mx-auto mb-4 opacity-40" />
            <h3 className="text-lg font-medium text-foreground">AttendFlow</h3>
            <p className="text-sm mt-2">Selecione uma conversa para começar a atender.</p>
          </div>
        </div>
      )}

      {/* Coluna 3: detalhes do contato */}
      {selected && <ContactPanel conversation={selected} />}
    </div>
  );
}

function ChatWindow({ conversation }: { conversation: Conversation }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: messages = [] } = useQuery({
    queryKey: ["messages", conversation.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conversation.id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Message[];
    },
    refetchInterval: 8000,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length]);

  const sendMutation = useMutation({
    mutationFn: async (content: string) => {
      const { data: u } = await supabase.auth.getUser();
      const userId = u.user?.id;
      if (!userId) throw new Error("Não autenticado");

      // Claim da conversa se ainda não estiver atribuída — necessário para o WITH CHECK do UPDATE
      const assignedId = conversation.assigned_agent_id ?? userId;

      const { error } = await supabase.from("messages").insert({
        conversation_id: conversation.id,
        sender_agent_id: userId,
        direction: "outbound",
        type: "text",
        content,
        status: "sent",
      });
      if (error) throw error;
      const { error: convError } = await supabase
        .from("conversations")
        .update({
          assigned_agent_id: assignedId,
          last_message_at: new Date().toISOString(),
          last_message_preview: content,
        })
        .eq("id", conversation.id);
      if (convError) throw convError;
    },
    onSuccess: () => {
      setText("");
      qc.invalidateQueries({ queryKey: ["messages", conversation.id] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    sendMutation.mutate(t);
  };

  return (
    <div className="flex-1 flex flex-col bg-[var(--chat-bg)]">
      <header className="h-16 px-4 flex items-center gap-3 bg-[var(--chat-panel)] border-b border-border">
        <Avatar className="w-10 h-10">
          <AvatarFallback className="bg-primary/20 text-primary">
            {conversation.contacts?.name?.[0]?.toUpperCase() ?? "?"}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1">
          <div className="font-medium">{conversation.contacts?.name}</div>
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            {channelIcon(conversation.channels?.type)} {conversation.channels?.name}
          </div>
        </div>
        <Badge variant="outline" className="capitalize">{conversation.status}</Badge>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-2">
        {messages.length === 0 && (
          <div className="text-center text-sm text-muted-foreground py-12">
            Sem mensagens ainda. Envie a primeira!
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.direction === "outbound" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[65%] px-3 py-2 rounded-lg text-sm shadow-sm ${
                m.direction === "outbound"
                  ? "bg-[var(--chat-bubble-out)] text-foreground rounded-tr-none"
                  : "bg-[var(--chat-bubble-in)] text-foreground rounded-tl-none"
              }`}
            >
              <div className="whitespace-pre-wrap break-words">{m.content}</div>
              <div className="text-[10px] text-muted-foreground mt-1 flex items-center gap-1 justify-end">
                {format(new Date(m.created_at), "HH:mm")}
                {m.direction === "outbound" && (
                  m.status === "read" ? <CheckCheck className="w-3 h-3 text-primary" /> :
                  m.status === "delivered" ? <CheckCheck className="w-3 h-3" /> :
                  <Check className="w-3 h-3" />
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={handleSend} className="bg-[var(--chat-panel)] px-4 py-3 flex items-center gap-2 border-t border-border">
        <Button type="button" variant="ghost" size="icon"><Smile className="w-5 h-5" /></Button>
        <Button type="button" variant="ghost" size="icon"><Paperclip className="w-5 h-5" /></Button>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Digite uma mensagem"
          className="bg-input border-0 flex-1"
        />
        <Button type="submit" size="icon" disabled={!text.trim() || sendMutation.isPending}>
          <Send className="w-4 h-4" />
        </Button>
      </form>
    </div>
  );
}

function ContactPanel({ conversation }: { conversation: Conversation }) {
  const c = conversation.contacts;
  return (
    <aside className="w-80 border-l border-border bg-sidebar p-6 overflow-y-auto">
      <div className="flex flex-col items-center text-center mb-6">
        <Avatar className="w-24 h-24 mb-3">
          <AvatarFallback className="bg-primary/20 text-primary text-2xl">
            {c?.name?.[0]?.toUpperCase() ?? "?"}
          </AvatarFallback>
        </Avatar>
        <h3 className="font-semibold text-lg">{c?.name}</h3>
        <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
          {channelIcon(conversation.channels?.type)} {conversation.channels?.name}
        </p>
      </div>

      <div className="space-y-4 text-sm">
        {c?.phone && (
          <div className="flex items-center gap-3">
            <Phone className="w-4 h-4 text-muted-foreground" />
            <span>{c.phone}</span>
          </div>
        )}
        {c?.email && (
          <div className="flex items-center gap-3">
            <Mail className="w-4 h-4 text-muted-foreground" />
            <span className="truncate">{c.email}</span>
          </div>
        )}
        <div>
          <div className="flex items-center gap-2 text-muted-foreground mb-2">
            <Tag className="w-4 h-4" /> Tags
          </div>
          <div className="flex flex-wrap gap-1">
            {conversation.tags?.length ? conversation.tags.map((t) => (
              <Badge key={t} variant="secondary">{t}</Badge>
            )) : <span className="text-xs text-muted-foreground">Sem tags</span>}
          </div>
        </div>
        {conversation.last_message_at && (
          <div className="text-xs text-muted-foreground pt-4 border-t border-border">
            Última mensagem: {formatDistanceToNow(new Date(conversation.last_message_at), { addSuffix: true, locale: ptBR })}
          </div>
        )}
      </div>
    </aside>
  );
}
