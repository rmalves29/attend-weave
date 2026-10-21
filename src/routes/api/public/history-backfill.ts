// Backfill do histórico antigo do WhatsApp. Chamado pelo agendamento do banco
// (armado ao sincronizar, desarmado aqui quando a fila esvazia). Autenticado
// por um segredo aleatório guardado só no banco (app_private.backfill_secret).
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/history-backfill")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const provided = request.headers.get("x-backfill-secret") ?? "";
        if (!/^[a-f0-9]{64}$/.test(provided)) return new Response("unauthorized", { status: 401 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: ok } = await supabaseAdmin.rpc("check_backfill_secret" as any, { _secret: provided });
        if (!ok) return new Response("unauthorized", { status: 401 });

        // 1) Descoberta: enfileira todas as conversas de números recém-conectados.
        // Enquanto houver canal descobrindo, a tick é dedicada a isso (é rápido:
        // só lista e enfileira). Depois, cada tick faz o backfill do histórico.
        const { runDiscoveryStep } = await import("@/lib/uazapi-discovery.server");
        let disc = { stillDiscovering: false, didWork: false, enqueued: 0 };
        try {
          disc = await runDiscoveryStep(supabaseAdmin, { deadline: Date.now() + 45_000 });
        } catch (e) {
          console.error("[history-backfill] discovery err:", (e as Error).message);
        }

        // 2) Backfill do histórico (pula se esta tick foi gasta descobrindo).
        const { runBackfillBatch } = await import("@/lib/uazapi-history.server");
        let result = { processed: 0, added: 0, remaining: 1 };
        if (!disc.didWork) {
          result = await runBackfillBatch(supabaseAdmin, {
            deadline: Date.now() + 50_000,
            concurrency: 3,
            limit: 20,
          });
        }

        // Só desarma quando a descoberta E a fila de backfill terminaram.
        if (!disc.stillDiscovering && !disc.didWork && result.remaining === 0) {
          await supabaseAdmin.rpc("disarm_history_backfill" as any);
        }
        const out = { ...result, discovery: disc };
        console.log("[history-backfill]", JSON.stringify(out));
        return Response.json({ ok: true, ...out });
      },
    },
  },
});
