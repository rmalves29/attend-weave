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

        const { runBackfillBatch } = await import("@/lib/uazapi-history.server");
        const result = await runBackfillBatch(supabaseAdmin, {
          deadline: Date.now() + 50_000,
          concurrency: 3,
          limit: 20,
        });
        if (result.remaining === 0) {
          await supabaseAdmin.rpc("disarm_history_backfill" as any);
        }
        console.log("[history-backfill]", JSON.stringify(result));
        return Response.json({ ok: true, ...result });
      },
    },
  },
});
