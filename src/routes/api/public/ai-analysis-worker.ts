// Worker da Análise com IA. Chamado pelo agendamento do banco (armado ao criar
// uma análise, desarmado aqui quando não há análise pendente). Autenticado por
// segredo guardado só no banco (app_private.ai_worker_secret).
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/ai-analysis-worker")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const provided = request.headers.get("x-worker-secret") ?? "";
        if (!/^[a-f0-9]{64}$/.test(provided)) return new Response("unauthorized", { status: 401 });
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: ok } = await supabaseAdmin.rpc("check_ai_worker_secret" as any, { _secret: provided });
        if (!ok) return new Response("unauthorized", { status: 401 });

        const { count } = await supabaseAdmin.from("ai_analyses" as any)
          .select("id", { count: "exact", head: true }).in("status", ["queued", "running", "summarizing"]);
        if (!count) {
          await supabaseAdmin.rpc("disarm_ai_analysis_worker" as any);
          return Response.json({ ok: true, idle: true });
        }

        const { data: id } = await supabaseAdmin.rpc("claim_ai_analysis" as any, { _secs: 170 });
        if (!id) return Response.json({ ok: true, busy: true });

        const { processAnalysis } = await import("@/lib/ai-analysis.server");
        const result = await processAnalysis(supabaseAdmin, id as string, Date.now() + 150_000);
        await supabaseAdmin.from("ai_analyses" as any).update({ lease_until: null }).eq("id", id);
        console.log("[ai-analysis-worker]", JSON.stringify(result));
        return Response.json({ ok: true, ...result });
      },
    },
  },
});
