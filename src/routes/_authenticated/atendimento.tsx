import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo, useRef, useEffect, useLayoutEffect } from "react";
import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeMessages } from "@/hooks/useRealtimeMessages";
import { usePresence } from "@/hooks/usePresence";
import {
  sendUazapiMessage, sendUazapiMedia, syncUazapiHistory, getMessageMedia,
  deleteUazapiMessage, forwardUazapiMessage, loadOlderMessages,
} from "@/lib/uazapi.functions";
import {
  transferConversation, setConversationStatus, addInternalNote,
  applyConversationTag, removeConversationTag,
} from "@/lib/conversations.functions";
import {
  scheduleMessage, listScheduledMessages, cancelScheduledMessage,
} from "@/lib/scheduled-messages.functions";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Search, Send, Smile, Paperclip, Phone, Mail, Tag, MessageCircle,
  Instagram, Facebook, Check, CheckCheck, RefreshCw, DownloadCloud, Loader2,
  MoreVertical, Reply, Forward, Trash2, X, StickyNote, ArrowRightLeft,
  CheckCircle2, RotateCcw, Zap, Plus, Clock, CalendarClock, Eye,
  ArrowLeft, PanelRightClose, PanelRightOpen,
} from "lucide-react";
import { toast } from "sonner";
import EmojiPicker, { EmojiStyle, Theme } from "emoji-picker-react";
import { formatDistanceToNow, format, isToday, isYesterday, isSameDay, isSameYear } from "date-fns";
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
  contacts: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    avatar_url: string | null;
    external_id?: string | null;
    metadata?: { whatsapp?: { is_group?: boolean; remote_jid?: string } } | null;
  };
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
  metadata?: any;
  is_internal?: boolean;
};

type QuickReply = { id: string; shortcut: string; content: string };

type ReplyDraft = { id: string; content: string; type: string; direction: string };

function renderWithMentions(content: string | null) {
  if (!content) return content;
  const parts = content.split(/(@[\p{L}0-9._-]+(?:\s[\p{L}0-9._-]+)?)/gu);
  return parts.map((part, i) =>
    part.startsWith("@")
      ? <span key={i} className="font-semibold text-primary">{part}</span>
      : <span key={i}>{part}</span>
  );
}

function dayLabel(date: Date) {
  if (isToday(date)) return "Hoje";
  if (isYesterday(date)) return "Ontem";
  if (isSameYear(date, new Date())) return format(date, "EEEE, d 'de' MMMM", { locale: ptBR });
  return format(date, "dd/MM/yyyy");
}


const channelIcon = (type: string) => {
  if (type === "instagram") return <Instagram className="w-3 h-3" />;
  if (type === "facebook") return <Facebook className="w-3 h-3" />;
  return <MessageCircle className="w-3 h-3" />;
};

function isGroupConversation(conversation: Conversation): boolean {
  const contact = conversation.contacts;
  return conversation.channels?.type === "whatsapp" && Boolean(
    contact?.metadata?.whatsapp?.is_group ||
    contact?.metadata?.whatsapp?.remote_jid?.endsWith("@g.us") ||
    contact?.external_id?.endsWith("@g.us") ||
    contact?.phone?.endsWith("@g.us"),
  );
}

function AtendimentoPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<
    "all" | "unread" | "open" | "pending" | "resolved" | "groups"
  >("all");
  const [tagFilter, setTagFilter] = useState<string>("");
  const [panelOpen, setPanelOpen] = useState(true);

  const qc = useQueryClient();

  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user) return null;
      const { data: profile } = await supabase
        .from("profiles").select("id, name").eq("id", data.user.id).maybeSingle();
      return { id: data.user.id, name: profile?.name ?? data.user.email ?? "Atendente" };
    },
    staleTime: 5 * 60_000,
  });

  useRealtimeMessages(selectedId, me?.id);

  // Permissão de notificação desktop (uma vez)
  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  const { data: conversations = [], isFetching: isFetchingConvs, refetch: refetchConvs } = useQuery({
    queryKey: ["conversations"],
    queryFn: async () => {
      const PAGE_SIZE = 1000;
      const allConversations: Conversation[] = [];

      // O Data API pode limitar cada resposta a 1.000 registros. Busca em
      // páginas para que a tela não pare silenciosamente nesse limite.
      for (let page = 0; page < 100; page++) {
        const from = page * PAGE_SIZE;
        const { data, error } = await supabase
          .from("conversations")
          .select("*, contacts(*), channels(id,name,type,identifier,status)")
          // Não limita por data: exibe todas as conversas importadas,
          // inclusive antigas e grupos sem mensagens.
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .order("created_at", { ascending: false })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;

        const rows = (data ?? []) as unknown as Conversation[];
        allConversations.push(...rows);
        if (rows.length < PAGE_SIZE) break;
      }

      return allConversations;
    },
    refetchInterval: 10000,
    refetchOnWindowFocus: true,
  });

  const syncFn = useServerFn(syncUazapiHistory);
  const syncCursorRef = useRef<{
    channelIndex: number;
    chatIndex: number;
    messageOffset: number;
  } | null>(null);
  const syncMutation = useMutation({
    mutationFn: async () => {
      let cursor = syncCursorRef.current ?? undefined;
      let totalIngested = 0;
      let totalChats = 0;
      let totalHistoryRequested = 0;
      let totalWebhookErrors = 0;
      let totalErrors = 0;
      let groupsFound = 0;
      let lastResult: Awaited<ReturnType<typeof syncFn>> | null = null;

      // Continua automaticamente de onde a rajada anterior parou. Assim um
      // único clique percorre todas as páginas de chats e mensagens.
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await syncFn({
          data: { perChatLimit: 10000, cursor },
        });
        lastResult = result;
        totalIngested += result.ingested ?? 0;
        totalChats += result.chats ?? 0;
        totalHistoryRequested += result.historyRequested ?? 0;
        totalWebhookErrors += result.webhookErrors ?? 0;
        totalErrors += result.errors ?? 0;
        groupsFound = Math.max(groupsFound, result.groups ?? 0);

        if (!result.partial) {
          syncCursorRef.current = null;
          return {
            ...result,
            ingested: totalIngested,
            chats: totalChats,
            historyRequested: totalHistoryRequested,
            webhookErrors: totalWebhookErrors,
            errors: totalErrors,
            groups: groupsFound,
          };
        }

        cursor = result.cursor ?? undefined;
        syncCursorRef.current = cursor ?? null;
        if (!cursor) break;
        toast.loading(
          `Sincronizando… ${totalChats} conversas processadas e ${totalIngested} mensagens novas`,
          { id: "whatsapp-history-sync" },
        );
      }

      if (!lastResult) throw new Error("A sincronização não retornou resultado.");
      return {
        ...lastResult,
        ingested: totalIngested,
        chats: totalChats,
        historyRequested: totalHistoryRequested,
        webhookErrors: totalWebhookErrors,
        errors: totalErrors,
        groups: groupsFound,
        partial: true as const,
        cursor: syncCursorRef.current,
      };
    },
    onMutate: () => {
      toast.loading("Sincronizando conversas, grupos e mensagens…", { id: "whatsapp-history-sync" });
    },
    onSuccess: (r) => {
      syncCursorRef.current = r.partial ? (r.cursor ?? null) : null;
      const suffix = (r.historyRequested ?? 0) > 0
        ? ` O WhatsApp ainda pode enviar histórico anterior de ${r.historyRequested} conversa(s).`
        : "";
      const webhookWarning = (r.webhookErrors ?? 0) > 0
        ? " Não foi possível atualizar o webhook; tente sincronizar novamente."
        : "";
      if (r.partial) {
        toast.info(
          `Sincronização avançou: ${r.ingested} mensagens novas e ${r.groups ?? 0} grupos encontrados. Clique novamente para continuar.${suffix}${webhookWarning}`,
          { id: "whatsapp-history-sync", duration: 8000 },
        );
      } else {
        toast.success(
          `Sincronizado: ${r.ingested} mensagens novas e ${r.groups ?? 0} grupos encontrados.${suffix}${webhookWarning}`,
          { id: "whatsapp-history-sync", duration: 8000 },
        );
      }
      refetchConvs();
      if (selectedId) qc.invalidateQueries({ queryKey: ["messages"] });
    },
    onError: (e: any) => toast.error(
      e?.message ?? "Falha ao sincronizar",
      { id: "whatsapp-history-sync" },
    ),
  });

  const handleRefresh = () => {
    refetchConvs();
    if (selectedId) qc.invalidateQueries({ queryKey: ["messages"] });
  };

  const filtered = useMemo(() => {
    return conversations.filter((c) => {
      const isGroup = isGroupConversation(c);
      if (filter === "groups") {
        if (!isGroup) return false;
      } else {
        // Grupos ficam isolados no filtro próprio e nunca aparecem misturados
        // às filas de atendimento individual.
        if (isGroup) return false;
        if (filter === "unread") {
          if (!(c.unread_count > 0)) return false;
        } else if (filter !== "all" && c.status !== filter) return false;
      }
      if (tagFilter && !(c.tags ?? []).some((t) => t.toLowerCase() === tagFilter)) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return c.contacts?.name?.toLowerCase().includes(q) || c.last_message_preview?.toLowerCase().includes(q);
    });
  }, [conversations, search, filter, tagFilter]);

  const tagOptions = useMemo(
    () => Array.from(new Set(conversations.flatMap((c) => (c.tags ?? []).map((t) => t.toLowerCase())))).sort(),
    [conversations],
  );

  const unreadTotal = useMemo(
    () => conversations.reduce(
      (sum, c) => sum + (!isGroupConversation(c) && c.unread_count > 0 ? c.unread_count : 0),
      0,
    ),
    [conversations],
  );
  const unreadConvCount = useMemo(
    () => conversations.filter(
      (c) => !isGroupConversation(c) && c.unread_count > 0,
    ).length,
    [conversations],
  );
  const groupCount = useMemo(
    () => conversations.filter(isGroupConversation).length,
    [conversations],
  );

  const selected = conversations.find((c) => c.id === selectedId);

  // Ao abrir uma conversa com não-lidas, zera o contador (marca como lida).
  const openConversation = async (id: string) => {
    setSelectedId(id);
    const conv = conversations.find((c) => c.id === id);
    if (conv && conv.unread_count > 0) {
      // Otimista no cache
      qc.setQueryData<Conversation[]>(["conversations"], (prev) =>
        prev?.map((c) => (c.id === id ? { ...c, unread_count: 0 } : c)) ?? prev,
      );
      await supabase.from("conversations").update({ unread_count: 0 }).eq("id", id);
    }
  };

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* Coluna 1: lista de conversas */}
      <div className={`${selected ? "hidden md:flex" : "flex"} w-full md:w-80 shrink-0 min-h-0 border-r border-border bg-sidebar flex-col`}>
        <div className="p-3 border-b border-border">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-lg">Conversas</h2>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              title="Sincronizar histórico da uazapi"
              className="h-8 w-8"
            >
              <DownloadCloud className={`w-4 h-4 ${syncMutation.isPending ? "animate-pulse" : ""}`} />
            </Button>
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
          <div className="flex gap-1 mt-3 text-xs flex-wrap">
            {(["all", "unread", "open", "pending", "resolved", "groups"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1 rounded-full transition-colors inline-flex items-center gap-1 ${
                  filter === f ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"
                }`}
              >
                {f === "all"
                  ? "Todos"
                  : f === "unread"
                    ? "Não lidas"
                    : f === "open"
                      ? "Abertos"
                    : f === "pending"
                      ? "Pendentes"
                      : f === "resolved"
                        ? "Resolvidos"
                        : "Grupos"}
                {f === "unread" && unreadConvCount > 0 && (
                  <span className={`ml-0.5 rounded-full px-1.5 h-4 min-w-4 inline-flex items-center justify-center text-[10px] font-semibold ${
                    filter === f ? "bg-primary-foreground/20 text-primary-foreground" : "bg-emerald-500 text-white"
                  }`}>
                    {unreadConvCount}
                  </span>
                )}
                {f === "groups" && groupCount > 0 && (
                  <span className={`ml-0.5 rounded-full px-1.5 h-4 min-w-4 inline-flex items-center justify-center text-[10px] font-semibold ${
                    filter === f ? "bg-primary-foreground/20 text-primary-foreground" : "bg-emerald-500 text-white"
                  }`}>
                    {groupCount}
                  </span>
                )}
              </button>
            ))}
          </div>
          {tagOptions.length > 0 && (
            <select
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              className="mt-2 w-full h-8 rounded-md bg-input text-xs px-2 border-0"
              aria-label="Filtrar por etiqueta"
            >
              <option value="">Todas as etiquetas</option>
              {tagOptions.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          {unreadTotal > 0 && (
            <div className="mt-2 text-[11px] text-muted-foreground">
              {unreadConvCount} {unreadConvCount === 1 ? "conversa" : "conversas"} · {unreadTotal} {unreadTotal === 1 ? "mensagem não lida" : "mensagens não lidas"}
            </div>
          )}
        </div>
        <ScrollArea className="flex-1 min-h-0">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {filter === "groups" ? "Nenhum grupo encontrado." : "Nenhuma conversa encontrada."}
            </div>
          ) : (
            filtered.map((c) => {
              const isUnread = c.unread_count > 0;
              return (
                <button
                  key={c.id}
                  onClick={() => openConversation(c.id)}
                  className={`w-full text-left px-3 py-3 flex gap-3 border-b border-border/50 transition-colors relative ${
                    selectedId === c.id
                      ? "bg-accent"
                      : isUnread
                        ? "bg-emerald-500/10 hover:bg-emerald-500/[0.14]"
                        : "hover:bg-accent"
                  }`}
                >
                  {isUnread && (
                    <span className="absolute left-0 top-0 bottom-0 w-1 bg-emerald-500" aria-hidden />
                  )}
                  <Avatar className="w-12 h-12 flex-shrink-0">
                    <AvatarFallback className="bg-emerald-500/20 text-emerald-600">
                      {c.contacts?.name?.[0]?.toUpperCase() ?? "?"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-center gap-2">
                      <span className={`truncate ${isUnread ? "font-bold text-foreground" : "font-medium"}`}>
                        {c.contacts?.name}
                      </span>
                      <span className={`text-xs flex-shrink-0 ${isUnread ? "text-emerald-600 font-semibold" : "text-muted-foreground"}`}>
                        {c.last_message_at ? format(new Date(c.last_message_at), "HH:mm") : ""}
                      </span>
                    </div>
                    <div className="flex justify-between items-center gap-2 mt-0.5">
                      <span className={`text-sm truncate flex items-center gap-1 ${isUnread ? "text-foreground font-semibold" : "text-muted-foreground"}`}>
                        {channelIcon(c.channels?.type)} {c.last_message_preview ?? "—"}
                      </span>
                      {isUnread && (
                        <Badge className="bg-primary text-primary-foreground h-5 min-w-5 px-1.5 rounded-full text-xs">
                          {c.unread_count}
                        </Badge>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </ScrollArea>
      </div>

      {/* Coluna 2: chat */}
      {selected ? (
        <ChatWindow
          key={selected.id}
          conversation={selected}
          me={me ?? null}
          onBack={() => setSelectedId(null)}
          panelOpen={panelOpen}
          onTogglePanel={() => setPanelOpen((v) => !v)}
        />
      ) : (
        <div className="hidden md:flex flex-1 items-center justify-center bg-[var(--chat-bg)] text-muted-foreground">
          <div className="text-center max-w-md p-6">
            <MessageCircle className="w-16 h-16 mx-auto mb-4 opacity-40" />
            <h3 className="text-lg font-medium text-foreground">AttendFlow</h3>
            <p className="text-sm mt-2">Selecione uma conversa para começar a atender.</p>
          </div>
        </div>
      )}

      {/* Coluna 3: detalhes do contato */}
      {selected && panelOpen && (
        <div className="hidden lg:flex min-h-0">
          <ContactPanel conversation={selected} />
        </div>
      )}
    </div>
  );
}

const MSG_PAGE = 50;

function ChatWindow({
  conversation, me, onBack, panelOpen, onTogglePanel,
}: {
  conversation: Conversation;
  me: { id: string; name: string } | null;
  onBack: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [reply, setReply] = useState<ReplyDraft | null>(null);
  const [forwardMsg, setForwardMsg] = useState<Message | null>(null);
  const [noteMode, setNoteMode] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const viewers = usePresence(conversation.id, me?.id, me?.name);

  // Respostas rápidas: digite /atalho para sugerir
  const { data: quickReplies = [] } = useQuery({
    queryKey: ["quick-replies"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("quick_replies" as any).select("id, shortcut, content").order("shortcut");
      if (error) throw error;
      return (data ?? []) as unknown as QuickReply[];
    },
    staleTime: 60_000,
  });
  const slashQuery = text.startsWith("/") ? text.slice(1).toLowerCase() : null;
  const slashMatches = slashQuery !== null
    ? quickReplies.filter((q) => q.shortcut.toLowerCase().startsWith(slashQuery)).slice(0, 6)
    : [];

  // Menções @agente no modo nota interna
  const { data: agents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("id, name").order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
    staleTime: 5 * 60_000,
  });
  const mentionMatch = noteMode ? /@([\p{L}0-9._-]*)$/u.exec(text) : null;
  const mentionQuery = mentionMatch?.[1]?.toLowerCase() ?? null;
  const mentionMatches = mentionQuery !== null
    ? agents.filter((a) => a.name.toLowerCase().includes(mentionQuery)).slice(0, 6)
    : [];
  const pickMention = (agent: { id: string; name: string }) => {
    if (!mentionMatch) return;
    const start = text.length - mentionMatch[0].length;
    setText(text.slice(0, start) + `@${agent.name} ` + text.slice(text.length));
    setMentionIds((prev) => Array.from(new Set([...prev, agent.id])));
  };

  // Paginação reversa (padrão WhatsApp Web): página 0 = mais recentes.
  const msgsQuery = useInfiniteQuery({
    queryKey: ["messages", conversation.contact_id, conversation.channel_id],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const { data: relatedConversations, error: convErr } = await supabase
        .from("conversations")
        .select("id")
        .eq("contact_id", conversation.contact_id)
        .eq("channel_id", conversation.channel_id);
      if (convErr) throw convErr;
      const ids = (relatedConversations ?? []).map((c) => c.id);
      if (!ids.length) return [] as Message[];
      let q = supabase
        .from("messages")
        .select("*")
        .in("conversation_id", ids)
        .order("created_at", { ascending: false })
        .limit(MSG_PAGE);
      if (pageParam) q = q.lt("created_at", pageParam);
      const { data, error } = await q;
      if (error) throw error;
      return ((data ?? []) as Message[]).reverse();
    },
    getNextPageParam: (last) => (last.length < MSG_PAGE ? undefined : last[0]?.created_at),
    refetchInterval: 8000,
  });
  const messages = useMemo(
    () => (msgsQuery.data?.pages ?? []).slice().reverse().flat(),
    [msgsQuery.data],
  );

  const { data: syncState, refetch: refetchSyncState } = useQuery({
    queryKey: ["history-sync-state", conversation.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("history_sync_state")
        .select("status, has_more")
        .eq("conversation_id", conversation.id)
        .maybeSingle();
      return data;
    },
  });
  const loadOlderFn = useServerFn(loadOlderMessages);
  const [phoneLoading, setPhoneLoading] = useState(false);
  const loadingOlderRef = useRef(false);
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const historyDone = syncState?.status === "done";
  const historyBlocked = syncState?.status === "blocked";

  const loadOlder = async () => {
    const el = scrollRef.current;
    if (!el || loadingOlderRef.current) return;
    if (msgsQuery.hasNextPage) {
      loadingOlderRef.current = true;
      anchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
      try { await msgsQuery.fetchNextPage(); } finally { loadingOlderRef.current = false; }
      return;
    }
    if (syncState?.has_more === false || historyDone || historyBlocked) return;
    if (conversation.channels?.type !== "whatsapp") return;
    loadingOlderRef.current = true;
    setPhoneLoading(true);
    try {
      const r = await loadOlderFn({ data: { conversationId: conversation.id } });
      if (r.added > 0) {
        anchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
        await msgsQuery.refetch();
      }
      await refetchSyncState();
    } catch (e: any) {
      toast.error(e?.message ?? "Falha ao buscar mensagens do celular");
    } finally {
      setPhoneLoading(false);
      // Pequena pausa evita disparar várias vezes enquanto o usuário segura o topo.
      setTimeout(() => { loadingOlderRef.current = false; }, 1500);
    }
  };

  const lastIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (anchorRef.current) {
      // Mantém a posição ao inserir mensagens antigas no topo.
      el.scrollTop = el.scrollHeight - anchorRef.current.height + anchorRef.current.top;
      anchorRef.current = null;
    } else {
      const newest = messages[messages.length - 1]?.id ?? null;
      if (newest !== lastIdRef.current) el.scrollTop = el.scrollHeight;
    }
    lastIdRef.current = messages[messages.length - 1]?.id ?? null;
  }, [messages]);

  const sendFn = useServerFn(sendUazapiMessage);
  const sendMutation = useMutation({
    mutationFn: (content: string) =>
      sendFn({ data: { conversationId: conversation.id, text: content, replyToMessageId: reply?.id } }),
    onSuccess: () => {
      setText(""); setReply(null);
      qc.invalidateQueries({ queryKey: ["messages"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao enviar"),
  });

  const sendMediaFn = useServerFn(sendUazapiMedia);
  const mediaMutation = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > 20 * 1024 * 1024) throw new Error("Arquivo maior que 20MB");
      const ext = file.name.includes(".") ? file.name.split(".").pop() : "";
      const path = `${conversation.id}/${crypto.randomUUID()}${ext ? "." + ext : ""}`;
      const { error: upErr } = await supabase.storage
        .from("attachments")
        .upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
      if (upErr) throw upErr;
      return sendMediaFn({
        data: {
          conversationId: conversation.id,
          storagePath: path,
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          caption: text.trim() || undefined,
          replyToMessageId: reply?.id,
        },
      });
    },
    onSuccess: () => {
      setText(""); setReply(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      qc.invalidateQueries({ queryKey: ["messages"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (e: any) => {
      toast.error(e?.message ?? "Falha ao enviar arquivo");
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
  });

  const deleteFn = useServerFn(deleteUazapiMessage);
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { messageId: id } }),
    onSuccess: () => {
      toast.success("Mensagem apagada");
      qc.invalidateQueries({ queryKey: ["messages"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao apagar"),
  });

  const noteFn = useServerFn(addInternalNote);
  const noteMutation = useMutation({
    mutationFn: (content: string) =>
      noteFn({ data: { conversationId: conversation.id, content, mentions: mentionIds } }),
    onSuccess: () => {
      setText("");
      setMentionIds([]);
      qc.invalidateQueries({ queryKey: ["messages"] });
      qc.invalidateQueries({ queryKey: ["internal-notes", conversation.id] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao salvar nota"),
  });

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    if (noteMode) noteMutation.mutate(t);
    else sendMutation.mutate(t);
  };

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    mediaMutation.mutate(f);
  };

  const messagePreview = (m: Message) => {
    if (m.type === "image") return "📷 Imagem";
    if (m.type === "video") return "🎥 Vídeo";
    if (m.type === "audio") return "🎵 Áudio";
    if (m.type === "document") return `📄 ${m.metadata?.media?.filename || "Documento"}`;
    return m.content ?? "";
  };

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-[var(--chat-bg)]">
      <header className="h-16 shrink-0 px-2 md:px-4 flex items-center gap-3 bg-[var(--chat-panel)] border-b border-border">
        <Button type="button" variant="ghost" size="icon" className="md:hidden" onClick={onBack} title="Voltar">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <Avatar className="w-10 h-10">
          <AvatarFallback className="bg-primary/20 text-primary">
            {conversation.contacts?.name?.[0]?.toUpperCase() ?? "?"}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{conversation.contacts?.name}</div>
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            {channelIcon(conversation.channels?.type)} {conversation.channels?.name}
          </div>
        </div>
        {viewers.length > 0 && (
          <div
            className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 px-2 py-1 rounded-full"
            title={`Também vendo esta conversa: ${viewers.map((v) => v.name).join(", ")}`}
          >
            <Eye className="w-3.5 h-3.5" />
            {viewers.length === 1 ? viewers[0].name : `${viewers.length} atendentes`}
          </div>
        )}
        <Badge variant="outline" className="capitalize">{conversation.status}</Badge>
        <ConversationActions conversation={conversation} />
        <Button
          type="button" variant="ghost" size="icon" className="hidden lg:inline-flex"
          onClick={onTogglePanel} title={panelOpen ? "Ocultar painel do contato" : "Mostrar painel do contato"}
        >
          {panelOpen ? <PanelRightClose className="w-5 h-5" /> : <PanelRightOpen className="w-5 h-5" />}
        </Button>
      </header>

      <div
        ref={scrollRef}
        onScroll={(e) => { if (e.currentTarget.scrollTop < 120) loadOlder(); }}
        className="flex-1 min-h-0 overflow-y-auto px-3 md:px-6 py-4"
      >
        <div className="flex justify-center py-2 min-h-8">
          {msgsQuery.isFetchingNextPage ? (
            <span className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Carregando…</span>
          ) : phoneLoading ? (
            <span className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Carregando mensagens do celular…</span>
          ) : msgsQuery.hasNextPage ? (
            <button type="button" className="text-xs text-primary hover:underline" onClick={loadOlder}>Carregar mensagens anteriores</button>
          ) : historyBlocked ? (
            <span className="text-[11px] px-3 py-1 rounded-full bg-muted text-muted-foreground">O WhatsApp não liberou mensagens mais antigas deste chat</span>
          ) : historyDone || syncState?.has_more === false || conversation.channels?.type !== "whatsapp" ? (
            messages.length > 0 ? <span className="text-[11px] px-3 py-1 rounded-full bg-muted text-muted-foreground">Início da conversa</span> : null
          ) : messages.length > 0 ? (
            <button type="button" className="text-xs text-primary hover:underline" onClick={loadOlder}>Buscar mensagens anteriores no celular</button>
          ) : null}
        </div>
        {messages.length === 0 && !msgsQuery.isLoading && (
          <div className="text-center text-sm text-muted-foreground py-12">
            Sem mensagens ainda. Envie a primeira!
          </div>
        )}
        {messages.map((m, idx) => {
          const prev = idx > 0 ? messages[idx - 1] : null;
          const showDay = !prev || !isSameDay(new Date(prev.created_at), new Date(m.created_at));
          const isOut = m.direction === "outbound";
          const deleted = m.metadata?.deleted;
          // Bolhas agrupadas: mesma direção, mesmo dia, sem nota entre elas.
          const grouped = !!prev && !showDay && !prev.is_internal && !m.is_internal && prev.direction === m.direction;
          const replyTo = m.metadata?.replyTo;
          const daySeparator = showDay ? (
            <div className="flex justify-center my-3">
              <span className="text-[11px] font-medium px-3 py-1 rounded-full bg-muted text-muted-foreground shadow-sm">
                {dayLabel(new Date(m.created_at))}
              </span>
            </div>
          ) : null;
          if (m.is_internal) {
            return (
              <div key={m.id} className="mt-2">
                {daySeparator}
                <div className="flex justify-center">
                  <div className="max-w-[70%] px-3 py-2 rounded-lg text-sm bg-amber-100 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-200">
                    <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide mb-0.5 opacity-80">
                      <StickyNote className="w-3 h-3" /> Nota interna
                    </div>
                    <div className="whitespace-pre-wrap break-words">{renderWithMentions(m.content)}</div>
                    <div className="text-[10px] opacity-60 mt-1 text-right">
                      {format(new Date(m.created_at), "HH:mm")}
                    </div>
                  </div>
                </div>
              </div>
            );
          }
          return (
            <div key={m.id} className={grouped ? "mt-0.5" : "mt-2"}>
              {daySeparator}
              <div className={`group flex items-start gap-1 ${isOut ? "justify-end" : "justify-start"}`}>
              {isOut && (
                <MessageActions
                  message={m}
                  onReply={() => setReply({ id: m.id, content: messagePreview(m), type: m.type, direction: m.direction })}
                  onForward={() => setForwardMsg(m)}
                  onDelete={() => deleteMutation.mutate(m.id)}
                  disabled={deleted}
                />
              )}
              <div
                className={`max-w-[65%] px-3 py-2 rounded-lg text-sm shadow-sm ${
                  isOut
                    ? `bg-[var(--chat-bubble-out)] text-foreground ${grouped ? "" : "rounded-tr-none"}`
                    : `bg-[var(--chat-bubble-in)] text-foreground ${grouped ? "" : "rounded-tl-none"}`
                } ${deleted ? "italic opacity-70" : ""}`}
              >
                {replyTo && (
                  <div className="mb-1.5 border-l-2 border-primary/60 pl-2 py-1 bg-black/5 dark:bg-white/5 rounded text-xs">
                    <div className="font-medium text-primary/90">Resposta</div>
                    <div className="text-muted-foreground truncate max-w-[280px]">{replyTo.content}</div>
                  </div>
                )}
                {m.metadata?.forwarded && (
                  <div className="text-[10px] text-muted-foreground italic flex items-center gap-1 mb-1">
                    <Forward className="w-3 h-3" /> Encaminhada
                  </div>
                )}
                {deleted ? (
                  <div className="whitespace-pre-wrap break-words">{m.content}</div>
                ) : ["image", "video", "audio", "document"].includes(m.type) ? (
                  <MediaBubble message={m} />
                ) : (
                  <div className="whitespace-pre-wrap break-words">{m.content}</div>
                )}
                <div className="text-[10px] text-muted-foreground mt-1 flex items-center gap-1 justify-end">
                  {format(new Date(m.created_at), "HH:mm")}
                  {isOut && !deleted && (
                    m.status === "read" ? <CheckCheck className="w-3 h-3 text-primary" /> :
                    m.status === "delivered" ? <CheckCheck className="w-3 h-3" /> :
                    <Check className="w-3 h-3" />
                  )}
                </div>
              </div>
              {!isOut && (
                <MessageActions
                  message={m}
                  onReply={() => setReply({ id: m.id, content: messagePreview(m), type: m.type, direction: m.direction })}
                  onForward={() => setForwardMsg(m)}
                  onDelete={() => deleteMutation.mutate(m.id)}
                  disabled={deleted}
                />
              )}
              </div>
            </div>
          );
        })}
      </div>

      {reply && (
        <div className="bg-[var(--chat-panel)] border-t border-border px-4 py-2 flex items-center gap-3">
          <div className="w-1 h-10 rounded bg-primary" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-primary">
              Respondendo {reply.direction === "outbound" ? "à sua mensagem" : "ao contato"}
            </div>
            <div className="text-xs text-muted-foreground truncate">{reply.content}</div>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={() => setReply(null)} title="Cancelar resposta">
            <X className="w-4 h-4" />
          </Button>
        </div>
      )}

      {mentionMatches.length > 0 && (
        <div className="bg-[var(--chat-panel)] border-t border-border px-4 py-2 space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            @ Mencionar atendente
          </div>
          {mentionMatches.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => pickMention(a)}
              className="w-full text-left px-2 py-1.5 rounded hover:bg-accent text-sm"
            >
              {a.name}
            </button>
          ))}
        </div>
      )}

      {slashMatches.length > 0 && (
        <div className="bg-[var(--chat-panel)] border-t border-border px-4 py-2 space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            <Zap className="w-3 h-3" /> Respostas rápidas
          </div>
          {slashMatches.map((q) => (
            <button
              key={q.id}
              type="button"
              onClick={() => setText(q.content)}
              className="w-full text-left px-2 py-1.5 rounded hover:bg-accent text-sm flex gap-2 items-baseline"
            >
              <span className="text-primary font-mono text-xs shrink-0">/{q.shortcut}</span>
              <span className="text-muted-foreground truncate">{q.content}</span>
            </button>
          ))}
        </div>
      )}

      {noteMode && (
        <div className="bg-amber-100 dark:bg-amber-950/40 border-t border-amber-300 dark:border-amber-800 px-4 py-1.5 text-xs text-amber-900 dark:text-amber-200 flex items-center gap-2">
          <StickyNote className="w-3.5 h-3.5" /> Modo nota interna — o cliente NÃO recebe esta mensagem
        </div>
      )}

      <form onSubmit={handleSend} className="shrink-0 bg-[var(--chat-panel)] px-2 md:px-4 py-3 flex items-center gap-2 border-t border-border">
        <Button
          type="button"
          variant={noteMode ? "default" : "ghost"}
          size="icon"
          title={noteMode ? "Voltar para mensagem normal" : "Nota interna (só a equipe vê)"}
          onClick={() => { setNoteMode((v) => !v); setMentionIds([]); }}
          className={noteMode ? "bg-amber-500 hover:bg-amber-600 text-white" : ""}
        >
          <StickyNote className="w-5 h-5" />
        </Button>
        <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="icon" title="Emojis">
              <Smile className="w-5 h-5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent side="top" align="start" className="p-0 w-auto border-0 bg-transparent shadow-none">
            <EmojiPicker
              theme={Theme.AUTO}
              emojiStyle={EmojiStyle.NATIVE}
              onEmojiClick={(e) => setText((prev) => prev + e.emoji)}
              searchPlaceholder="Buscar emoji..."
              width={320}
              height={380}
            />
          </PopoverContent>
        </Popover>

        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFilePick}
          accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="Anexar arquivo"
          disabled={mediaMutation.isPending}
          onClick={() => fileInputRef.current?.click()}
        >
          {mediaMutation.isPending
            ? <Loader2 className="w-5 h-5 animate-spin" />
            : <Paperclip className="w-5 h-5" />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="Agendar mensagem"
          disabled={noteMode}
          onClick={() => setScheduleOpen(true)}
        >
          <Clock className="w-5 h-5" />
        </Button>

        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            if (noteMode) return;
            const items = e.clipboardData?.items;
            if (!items) return;
            for (const it of Array.from(items)) {
              if (it.kind === "file") {
                const f = it.getAsFile();
                if (f) {
                  e.preventDefault();
                  const ext = (f.type.split("/")[1] || "png").split("+")[0];
                  const named = f.name && f.name !== "image.png"
                    ? f
                    : new File([f], `colada-${Date.now()}.${ext}`, { type: f.type });
                  mediaMutation.mutate(named);
                  return;
                }
              }
            }
          }}
          placeholder={noteMode ? "Escrever nota interna..." : reply ? "Responder..." : "Digite uma mensagem (/ para respostas rápidas)"}
          className="bg-input border-0 flex-1"
        />
        <Button type="submit" size="icon" disabled={!text.trim() || sendMutation.isPending || noteMutation.isPending}>
          <Send className="w-4 h-4" />
        </Button>
      </form>

      <ForwardDialog
        message={forwardMsg}
        currentConversationId={conversation.id}
        onClose={() => setForwardMsg(null)}
      />

      <ScheduleMessageDialog
        open={scheduleOpen}
        conversationId={conversation.id}
        initialText={text}
        onClose={() => setScheduleOpen(false)}
        onScheduled={() => { setText(""); setScheduleOpen(false); }}
      />
    </div>
  );
}

function ConversationActions({ conversation }: { conversation: Conversation }) {
  const qc = useQueryClient();
  const transferFn = useServerFn(transferConversation);
  const statusFn = useServerFn(setConversationStatus);

  const { data: agents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("id, name").order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
    staleTime: 5 * 60_000,
  });

  const transferMutation = useMutation({
    mutationFn: (toAgentId: string) =>
      transferFn({ data: { conversationId: conversation.id, toAgentId } }),
    onSuccess: () => {
      toast.success("Conversa transferida");
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao transferir"),
  });

  const statusMutation = useMutation({
    mutationFn: (status: "open" | "resolved") =>
      statusFn({ data: { conversationId: conversation.id, status } }),
    onSuccess: (_r, status) => {
      toast.success(status === "resolved" ? "Conversa resolvida" : "Conversa reaberta");
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao mudar status"),
  });

  const isResolved = conversation.status === "resolved" || conversation.status === "closed";

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title={isResolved ? "Reabrir conversa" : "Marcar como resolvida"}
        disabled={statusMutation.isPending}
        onClick={() => statusMutation.mutate(isResolved ? "open" : "resolved")}
      >
        {isResolved ? <RotateCcw className="w-5 h-5" /> : <CheckCircle2 className="w-5 h-5" />}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" title="Transferir conversa">
            <ArrowRightLeft className="w-5 h-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <div className="px-2 py-1.5 text-xs text-muted-foreground">Transferir para</div>
          <DropdownMenuSeparator />
          {agents.length === 0 && (
            <div className="px-2 py-2 text-xs text-muted-foreground">Nenhum atendente</div>
          )}
          {agents.map((a) => (
            <DropdownMenuItem
              key={a.id}
              disabled={transferMutation.isPending || a.id === conversation.assigned_agent_id}
              onClick={() => transferMutation.mutate(a.id)}
            >
              {a.name}
              {a.id === conversation.assigned_agent_id && (
                <span className="ml-auto text-[10px] text-muted-foreground">atual</span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function MessageActions({
  message, onReply, onForward, onDelete, disabled,
}: {
  message: Message;
  onReply: () => void;
  onForward: () => void;
  onDelete: () => void;
  disabled?: boolean;
}) {
  if (disabled) return <div className="w-7" />;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button" variant="ghost" size="icon"
          className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
          title="Ações"
        >
          <MoreVertical className="w-4 h-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={message.direction === "outbound" ? "end" : "start"}>
        <DropdownMenuItem onClick={onReply}>
          <Reply className="w-4 h-4 mr-2" /> Responder
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onForward}>
          <Forward className="w-4 h-4 mr-2" /> Encaminhar
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
          <Trash2 className="w-4 h-4 mr-2" /> Apagar
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ForwardDialog({
  message, currentConversationId, onClose,
}: {
  message: Message | null;
  currentConversationId: string;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const qc = useQueryClient();
  const forwardFn = useServerFn(forwardUazapiMessage);

  const { data: convs = [] } = useQuery({
    queryKey: ["forward-targets"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select("id, contacts(name, phone), channels(name, type)")
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(200);
      if (error) throw error;
      return data as any[];
    },
    enabled: !!message,
  });

  const forwardMutation = useMutation({
    mutationFn: (targetId: string) =>
      forwardFn({ data: { messageId: message!.id, targetConversationId: targetId } }),
    onSuccess: () => {
      toast.success("Mensagem encaminhada");
      qc.invalidateQueries({ queryKey: ["conversations"] });
      onClose();
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao encaminhar"),
  });

  const filtered = convs.filter((c) => {
    if (c.id === currentConversationId) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return c.contacts?.name?.toLowerCase().includes(q) ||
      c.contacts?.phone?.includes(search);
  });

  return (
    <Dialog open={!!message} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Encaminhar mensagem</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Buscar contato..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <ScrollArea className="max-h-80">
          {filtered.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              Nenhum contato encontrado.
            </div>
          ) : filtered.map((c) => (
            <button
              key={c.id}
              disabled={forwardMutation.isPending}
              onClick={() => forwardMutation.mutate(c.id)}
              className="w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-accent rounded-md disabled:opacity-50"
            >
              <Avatar className="w-9 h-9">
                <AvatarFallback className="bg-primary/20 text-primary">
                  {c.contacts?.name?.[0]?.toUpperCase() ?? "?"}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{c.contacts?.name}</div>
                <div className="text-xs text-muted-foreground truncate flex items-center gap-1">
                  {channelIcon(c.channels?.type)} {c.channels?.name}
                </div>
              </div>
            </button>
          ))}
        </ScrollArea>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


function ScheduleMessageDialog({
  open, conversationId, initialText, onClose, onScheduled,
}: {
  open: boolean;
  conversationId: string;
  initialText: string;
  onClose: () => void;
  onScheduled: () => void;
}) {
  const qc = useQueryClient();
  const [content, setContent] = useState(initialText);
  const [sendAt, setSendAt] = useState("");
  const scheduleFn = useServerFn(scheduleMessage);

  useEffect(() => {
    if (open) setContent(initialText);
  }, [open, initialText]);

  const mutation = useMutation({
    mutationFn: () => {
      const local = new Date(sendAt);
      return scheduleFn({
        data: { conversationId, content: content.trim(), sendAt: local.toISOString() },
      });
    },
    onSuccess: () => {
      toast.success("Mensagem agendada");
      qc.invalidateQueries({ queryKey: ["scheduled-messages", conversationId] });
      setSendAt("");
      onScheduled();
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao agendar"),
  });

  // valor mínimo aceito pelo <input datetime-local>: agora, no fuso local
  const minLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="w-5 h-5" /> Agendar mensagem
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Mensagem a ser enviada..."
          />
          <Input
            type="datetime-local"
            value={sendAt}
            min={minLocal}
            onChange={(e) => setSendAt(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button
            disabled={!content.trim() || !sendAt || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Agendar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScheduledMessagesSection({ conversationId }: { conversationId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listScheduledMessages);
  const cancelFn = useServerFn(cancelScheduledMessage);

  const { data: items = [] } = useQuery({
    queryKey: ["scheduled-messages", conversationId],
    queryFn: () => listFn({ data: { conversationId } }),
    refetchInterval: 30_000,
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => cancelFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Agendamento cancelado");
      qc.invalidateQueries({ queryKey: ["scheduled-messages", conversationId] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao cancelar"),
  });

  if (items.length === 0) return null;

  return (
    <div className="pt-4 border-t border-border">
      <div className="flex items-center gap-2 text-muted-foreground mb-2">
        <CalendarClock className="w-4 h-4" /> Mensagens agendadas
      </div>
      <div className="space-y-2">
        {items.map((s) => (
          <div key={s.id} className="flex items-start gap-2 bg-muted/50 rounded-md p-2 text-xs">
            <div className="flex-1 min-w-0">
              <div className="text-muted-foreground">
                {format(new Date(s.send_at), "dd/MM HH:mm")}
              </div>
              <div className="truncate">{s.content}</div>
            </div>
            <button
              type="button"
              onClick={() => cancelMutation.mutate(s.id)}
              disabled={cancelMutation.isPending}
              className="text-muted-foreground hover:text-destructive shrink-0"
              title="Cancelar agendamento"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function MediaBubble({ message }: { message: Message }) {
  const fn = useServerFn(getMessageMedia);
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["message-media-v2", message.id],
    queryFn: () => fn({ data: { messageId: message.id } }),
    staleTime: 55 * 60 * 1000,
    retry: 1,
  });

  const caption = message.content && !message.content.startsWith("[") && !/^(📷|🎥|🎵|📄)/.test(message.content)
    ? message.content : null;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-4 px-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Carregando mídia...
      </div>
    );
  }
  if (error || !data?.url) {
    return (
      <div className="space-y-1">
        <div className="text-muted-foreground text-xs">{message.content ?? "Mídia indisponível"}</div>
        {error ? (
          <div className="text-destructive text-[11px] break-words max-w-xs">
            {(error as Error)?.message ?? String(error)}
          </div>
        ) : null}
        <button type="button" onClick={() => refetch()} disabled={isFetching}
          className="text-xs underline text-primary">
          {isFetching ? "Tentando..." : "Tentar novamente"}
        </button>
      </div>
    );
  }

  const mime = data.mimeType ?? "";
  const type = message.type;

  return (
    <div className="space-y-1">
      {type === "image" || mime.startsWith("image/") ? (
        <a href={data.url} target="_blank" rel="noreferrer">
          <img src={data.url} alt={data.filename ?? "imagem"} className="rounded max-w-full max-h-80 object-contain" />
        </a>
      ) : type === "video" || mime.startsWith("video/") ? (
        <video src={data.url} controls className="rounded max-w-full max-h-80" />
      ) : type === "audio" || mime.startsWith("audio/") ? (
        <audio src={data.url} controls className="w-full" />
      ) : (
        <a href={data.url} target="_blank" rel="noreferrer"
          className="flex items-center gap-2 underline text-primary">
          <Paperclip className="w-4 h-4" /> {data.filename ?? "Baixar arquivo"}
        </a>
      )}
      {caption && <div className="whitespace-pre-wrap break-words">{caption}</div>}
    </div>
  );
}

type TagDef = {
  id: string;
  name: string;
  sets_status: string | null;
  auto_message_enabled: boolean;
  auto_message_mode: "relative" | "absolute";
  auto_message_unit: "minutes" | "hours" | "days";
  auto_message_value: number;
  auto_message_at: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  open: "Aberta", pending: "Aguardando", resolved: "Finalizada", closed: "Fechada",
};

function TagsEditor({ conversation }: { conversation: Conversation }) {
  const qc = useQueryClient();
  const applyFn = useServerFn(applyConversationTag);
  const removeFn = useServerFn(removeConversationTag);

  // Etiquetas pré-definidas (cadastro em Configurações)
  const { data: allTags = [] } = useQuery({
    queryKey: ["tags"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tags" as any)
        .select("id, name, sets_status, auto_message_enabled, auto_message_mode, auto_message_unit, auto_message_value, auto_message_at")
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as TagDef[];
    },
    staleTime: 60_000,
  });

  const applyMutation = useMutation({
    mutationFn: (tagId: string) =>
      applyFn({ data: { conversationId: conversation.id, tagId } }),
    onSuccess: (_r, tagId) => {
      const tag = allTags.find((t) => t.id === tagId);
      if (tag?.sets_status) toast.success(`Etiqueta aplicada — conversa marcada como ${STATUS_LABEL[tag.sets_status] ?? tag.sets_status}`);
      else toast.success("Etiqueta aplicada");
      if (tag?.auto_message_enabled) {
        const when = tag.auto_message_mode === "absolute" && tag.auto_message_at
          ? new Date(tag.auto_message_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
          : `daqui a ${tag.auto_message_value} ${tag.auto_message_unit === "minutes" ? "min" : tag.auto_message_unit === "days" ? "dia(s)" : "h"}`;
        toast.info(`Mensagem automática agendada para ${when} (cancela se o cliente responder)`);
      }
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao aplicar etiqueta"),
  });

  const removeMutation = useMutation({
    mutationFn: (tagId: string) =>
      removeFn({ data: { conversationId: conversation.id, tagId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
    onError: (e: any) => toast.error(e?.message ?? "Falha ao remover etiqueta"),
  });

  const applied = conversation.tags ?? [];
  const available = allTags.filter((t) => !applied.includes(t.name));
  const byName = (name: string) => allTags.find((t) => t.name === name);

  return (
    <div>
      <div className="flex items-center gap-2 text-muted-foreground mb-2">
        <Tag className="w-4 h-4" /> Etiquetas
      </div>
      <div className="flex flex-wrap gap-1 mb-2">
        {applied.length ? applied.map((name) => {
          const tag = byName(name);
          return (
            <Badge key={name} variant="secondary" className="gap-1 pr-1">
              {name}
              {tag && (
                <button
                  type="button"
                  onClick={() => removeMutation.mutate(tag.id)}
                  disabled={removeMutation.isPending}
                  className="hover:text-destructive"
                  title={`Remover etiqueta ${name}`}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </Badge>
          );
        }) : <span className="text-xs text-muted-foreground">Sem etiquetas</span>}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="sm" variant="outline" className="h-8 text-xs w-full"
            disabled={applyMutation.isPending || available.length === 0}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            {available.length === 0 ? "Todas aplicadas" : "Adicionar etiqueta"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {available.map((t) => (
            <DropdownMenuItem key={t.id} onClick={() => applyMutation.mutate(t.id)}>
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">{t.name}</span>
                <span className="text-[10px] text-muted-foreground">
                  {t.sets_status ? `muda status → ${STATUS_LABEL[t.sets_status] ?? t.sets_status}` : "não muda status"}
                  {t.auto_message_enabled ? ` · msg automática ${t.auto_message_mode === "absolute" && t.auto_message_at ? `em ${new Date(t.auto_message_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : `em ${t.auto_message_value} ${t.auto_message_unit === "minutes" ? "min" : t.auto_message_unit === "days" ? "d" : "h"}`}` : ""}
                </span>
              </div>
            </DropdownMenuItem>
          ))}
          {allTags.length === 0 && (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              Nenhuma etiqueta cadastrada — crie em Configurações.
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function NotesSection({ conversationId }: { conversationId: string }) {
  const { data: notes = [] } = useQuery({
    queryKey: ["internal-notes", conversationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("messages")
        .select("id, content, created_at, sender_agent_id")
        .eq("conversation_id", conversationId)
        .eq("is_internal", true)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const agentIds = Array.from(new Set(notes.map((n: any) => n.sender_agent_id).filter(Boolean)));
  const { data: agents = [] } = useQuery({
    queryKey: ["note-agents", agentIds.sort().join(",")],
    enabled: agentIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("id, name").in("id", agentIds);
      return data ?? [];
    },
  });
  const agentName = (id: string | null) =>
    (agents as any[]).find((a) => a.id === id)?.name ?? "Atendente";

  return (
    <div className="pt-4 border-t border-border">
      <div className="flex items-center gap-2 mb-2 text-sm font-medium">
        <StickyNote className="w-4 h-4" /> Notas internas
        {notes.length > 0 && (
          <Badge variant="secondary" className="ml-auto">{notes.length}</Badge>
        )}
      </div>
      {notes.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nenhuma nota adicionada.</p>
      ) : (
        <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
          {notes.map((n: any) => {
            const d = new Date(n.created_at);
            return (
              <div key={n.id} className="rounded-md bg-amber-500/10 border border-amber-500/20 p-2">
                <p className="text-xs whitespace-pre-wrap break-words">
                  {renderWithMentions(n.content)}
                </p>
                <div className="mt-1 text-[10px] text-muted-foreground flex items-center justify-between">
                  <span>{agentName(n.sender_agent_id)}</span>
                  <span title={format(d, "dd/MM/yyyy HH:mm", { locale: ptBR })}>
                    {format(d, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


function ContactPanel({ conversation }: { conversation: Conversation }) {
  const c = conversation.contacts;
  return (
    <aside className="w-80 h-full border-l border-border bg-sidebar p-6 overflow-y-auto">
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
        <TagsEditor conversation={conversation} />
        <NotesSection conversationId={conversation.id} />
        <ScheduledMessagesSection conversationId={conversation.id} />
        {conversation.last_message_at && (
          <div className="text-xs text-muted-foreground pt-4 border-t border-border">
            Última mensagem: {formatDistanceToNow(new Date(conversation.last_message_at), { addSuffix: true, locale: ptBR })}
          </div>
        )}
      </div>
    </aside>
  );
}
