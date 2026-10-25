// Dispatcher de mensagens agendadas (Fase 2 do roadmap).
// Chamado pelo pg_cron (via pg_net, ver migration 20260710090000) a cada
// minuto. Autenticado por secret compartilhado — não usa JWT de usuário
// porque não há um usuário logado disparando a chamada.
import { createFileRoute } from "@tanstack/react-router";
import { createHash, timingSafeEqual } from "crypto";

export const Route = createFileRoute("/api/public/dispatch-scheduled-messages")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.CRON_SECRET;
        if (!expected) {
          console.error("[dispatch-scheduled] CRON_SECRET não configurado");
          return new Response("not configured", { status: 500 });
        }
        const provided = request.headers.get("x-cron-secret");
        const a = createHash("sha256").update(String(provided ?? "")).digest();
        const b = createHash("sha256").update(expected).digest();
        if (!timingSafeEqual(a, b) || String(provided ?? "").length !== expected.length) {
          return new Response("unauthorized", { status: 401 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { sendTextViaUazapi } = await import("@/lib/uazapi-send.server");

        const { data: due, error } = await supabaseAdmin
          .from("scheduled_messages" as any)
          .select("id, conversation_id, content, created_by")
          .eq("status", "pending")
          .lte("send_at", new Date().toISOString())
          .limit(50);
        if (error) {
          console.error("[dispatch-scheduled] erro ao buscar pendentes:", error.message);
          return new Response("db error", { status: 500 });
        }

        let sent = 0;
        let failed = 0;
        for (const item of (due ?? []) as any[]) {
          try {
            const result = await sendTextViaUazapi(supabaseAdmin, {
              conversationId: item.conversation_id,
              text: item.content,
              senderAgentId: item.created_by,
            });
            await supabaseAdmin
              .from("scheduled_messages" as any)
              .update({ status: "sent", sent_message_id: result.messageId ?? null, error: null })
              .eq("id", item.id);
            sent++;
          } catch (e) {
            console.error("[dispatch-scheduled] falha ao enviar", item.id, (e as Error).message);
            await supabaseAdmin
              .from("scheduled_messages" as any)
              .update({ status: "failed", error: (e as Error).message })
              .eq("id", item.id);
            failed++;
          }
        }

        // Carona no mesmo cron de minuto: dispara campanhas no ritmo (50/dia,
        // 1 a cada X min, janela de horário). Isolado em try/catch pra nunca
        // quebrar o envio das mensagens agendadas.
        let campaigns: any = null;
        try {
          const { dispatchDueCampaigns } = await import("@/lib/campaigns.server");
          campaigns = await dispatchDueCampaigns(supabaseAdmin, { maxPerRun: 5 });
        } catch (e) {
          console.error("[dispatch-scheduled] campanhas err:", (e as Error).message);
        }

        return new Response(
          JSON.stringify({ ok: true, sent, failed, checked: (due ?? []).length, campaigns }),
          {
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    },
  },
});
