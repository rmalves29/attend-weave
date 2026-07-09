import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

type Viewer = { userId: string; name: string };

// Colisão de agentes: mostra quem mais está com a mesma conversa aberta
// agora, via Supabase Realtime Presence (nenhuma tabela nova necessária).
export function usePresence(conversationId: string | null, userId?: string, userName?: string) {
  const [viewers, setViewers] = useState<Viewer[]>([]);

  useEffect(() => {
    if (!conversationId || !userId) {
      setViewers([]);
      return;
    }

    const channel = supabase.channel(`presence-conversation-${conversationId}`, {
      config: { presence: { key: userId } },
    });

    const sync = () => {
      const state = channel.presenceState<Viewer>();
      const others = Object.entries(state)
        .filter(([key]) => key !== userId)
        .map(([, entries]) => entries[0])
        .filter(Boolean);
      setViewers(others);
    };

    channel.on("presence", { event: "sync" }, sync).subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ userId, name: userName ?? "Atendente" });
      }
    });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId, userId, userName]);

  return viewers;
}
