import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// Mensagem "fresca" = aconteceu agora. Ingestões de histórico (sync manual ou
// /message/history-sync) inserem mensagens antigas em rajada — elas não devem
// tocar som nem virar notificação.
function isFresh(createdAt?: string | null) {
  if (!createdAt) return true;
  return Date.now() - new Date(createdAt).getTime() < 2 * 60_000;
}

// Beep curto via WebAudio — sem depender de arquivo de áudio.
function playBeep() {
  try {
    const Ctx = (window as any).AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
    osc.onended = () => ctx.close().catch(() => {});
  } catch {
    /* áudio bloqueado até interação do usuário — ok */
  }
}

function notifyInbound(title: string, content: string | null, tag: string) {
  playBeep();
  // Notificação desktop só quando a aba não está em foco
  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted" &&
    document.hidden
  ) {
    try {
      new Notification(title, {
        body: (content ?? "Nova mensagem recebida").slice(0, 120),
        tag,
      });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Subscribes to realtime changes on messages + conversations and invalidates
 * the relevant TanStack Query caches so the chat updates automatically.
 * Também toca som/notificação desktop para mensagens novas do cliente e
 * quando o usuário atual é @mencionado numa nota interna.
 */
export function useRealtimeMessages(conversationId?: string | null, currentUserId?: string) {
  const qc = useQueryClient();
  // Coalesce de invalidações: durante uma ingestão de histórico chegam dezenas
  // de INSERTs por segundo — invalidar a cada um vira uma tempestade de
  // refetches que trava a tela. Um timer agrupa tudo num refetch por segundo.
  const invalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const scheduleInvalidate = () => {
      if (invalidateTimer.current) return;
      invalidateTimer.current = setTimeout(() => {
        invalidateTimer.current = null;
        qc.invalidateQueries({ queryKey: ["messages"] });
        qc.invalidateQueries({ queryKey: ["conversations"] });
      }, 1000);
    };

    const channel = supabase
      .channel("attendflow-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, (payload) => {
        const row: any = payload.new ?? payload.old ?? {};
        scheduleInvalidate();
        if (payload.eventType !== "INSERT" || !isFresh(row.created_at)) return;

        if (row.direction === "inbound" && !row.is_internal) {
          notifyInbound("Nova mensagem — AttendFlow", row.content, "attendflow-inbound");
          return;
        }
        const mentions: string[] = row.metadata?.mentions ?? [];
        if (
          row.is_internal &&
          currentUserId &&
          row.sender_agent_id !== currentUserId &&
          mentions.includes(currentUserId)
        ) {
          notifyInbound("Você foi mencionado — AttendFlow", row.content, "attendflow-mention");
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () => {
        scheduleInvalidate();
      })
      .subscribe();

    return () => {
      if (invalidateTimer.current) {
        clearTimeout(invalidateTimer.current);
        invalidateTimer.current = null;
      }
      supabase.removeChannel(channel);
    };
  }, [qc, conversationId, currentUserId]);
}
