import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useRealtimeMessages } from "@/hooks/useRealtimeMessages";
import {
  sendUazapiMessage, sendUazapiMedia, syncUazapiHistory, getMessageMedia,
  deleteUazapiMessage, forwardUazapiMessage,
} from "@/lib/uazapi.functions";
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
  MoreVertical, Reply, Forward, Trash2, X,
} from "lucide-react";
import { toast } from "sonner";
import EmojiPicker, { EmojiStyle, Theme } from "emoji-picker-react";
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
  metadata?: any;
};

type ReplyDraft = { id: string; content: string; type: string; direction: string };

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
        .select("*, contacts(*), channels(id,name,type,identifier,status)")
        .order("last_message_at", { ascending: false, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as unknown as Conversation[];
    },
    refetchInterval: 10000,
    refetchOnWindowFocus: true,
  });

  const syncFn = useServerFn(syncUazapiHistory);
  const syncMutation = useMutation({
    mutationFn: () => syncFn({ data: {} }),
    onSuccess: (r) => {
      toast.success(`Sincronizado: ${r.ingested} mensagens novas`);
      refetchConvs();
      if (selectedId) qc.invalidateQueries({ queryKey: ["messages", selectedId] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao sincronizar"),
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
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [reply, setReply] = useState<ReplyDraft | null>(null);
  const [forwardMsg, setForwardMsg] = useState<Message | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const sendFn = useServerFn(sendUazapiMessage);
  const sendMutation = useMutation({
    mutationFn: (content: string) =>
      sendFn({ data: { conversationId: conversation.id, text: content, replyToMessageId: reply?.id } }),
    onSuccess: () => {
      setText(""); setReply(null);
      qc.invalidateQueries({ queryKey: ["messages", conversation.id] });
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
      qc.invalidateQueries({ queryKey: ["messages", conversation.id] });
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
      qc.invalidateQueries({ queryKey: ["messages", conversation.id] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha ao apagar"),
  });

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    sendMutation.mutate(t);
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
        {messages.map((m) => {
          const isOut = m.direction === "outbound";
          const deleted = m.metadata?.deleted;
          const replyTo = m.metadata?.replyTo;
          return (
            <div key={m.id} className={`group flex items-start gap-1 ${isOut ? "justify-end" : "justify-start"}`}>
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
                    ? "bg-[var(--chat-bubble-out)] text-foreground rounded-tr-none"
                    : "bg-[var(--chat-bubble-in)] text-foreground rounded-tl-none"
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

      <form onSubmit={handleSend} className="bg-[var(--chat-panel)] px-4 py-3 flex items-center gap-2 border-t border-border">
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

        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={reply ? "Responder..." : "Digite uma mensagem"}
          className="bg-input border-0 flex-1"
        />
        <Button type="submit" size="icon" disabled={!text.trim() || sendMutation.isPending}>
          <Send className="w-4 h-4" />
        </Button>
      </form>

      <ForwardDialog
        message={forwardMsg}
        currentConversationId={conversation.id}
        onClose={() => setForwardMsg(null)}
      />
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
  );
}

function MediaBubble({ message }: { message: Message }) {
  const fn = useServerFn(getMessageMedia);
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["message-media", message.id],
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
