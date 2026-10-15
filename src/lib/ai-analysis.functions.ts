// Server functions da Análise com IA. Iniciar/refazer: só admin.
// Ler: qualquer usuário com role em user_roles.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const MAX_CONVERSATIONS = 1500;

const filtersSchema = z.object({
  preset: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal("custom")]),
  since: z.string().optional(),
  until: z.string().optional(),
  channelId: z.string().uuid().nullable().optional(),
  includeGroups: z.boolean().default(false),
  minMessages: z.number().int().min(1).max(50).default(3),
});
export type AiFilters = z.infer<typeof filtersSchema>;

async function roles(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  if (error) throw new Error(error.message);
  const list = (data ?? []).map((r: any) => r.role as string);
  if (!list.length) throw new Error("Sem permissão.");
  return { isAdmin: list.includes("admin") };
}

function range(f: AiFilters) {
  if (f.preset === "custom") {
    if (!f.since || !f.until) throw new Error("Informe as duas datas.");
    const since = new Date(`${f.since.slice(0, 10)}T00:00:00-03:00`);
    const until = new Date(`${f.until.slice(0, 10)}T23:59:59-03:00`);
    if (!(since < until)) throw new Error("Período inválido.");
    return { since: since.toISOString(), until: until.toISOString() };
  }
  const until = new Date();
  return { since: new Date(until.getTime() - f.preset * 86_400_000).toISOString(), until: until.toISOString() };
}

async function candidates(f: AiFilters) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const r = range(f);
  const { data, error } = await supabaseAdmin.rpc("ai_analysis_candidates" as any, {
    _since: r.since, _until: r.until, _channel_ids: f.channelId ? [f.channelId] : null,
    _include_groups: f.includeGroups, _min_messages: f.minMessages,
  });
  if (error) throw new Error(error.message);
  const all = (data ?? []) as { conversation_id: string; msg_count: number; chars: number }[];
  const picked = all.slice(0, MAX_CONVERSATIONS);
  return { ...r, all, picked, sampled: all.length > MAX_CONVERSATIONS };
}

function estimate(n: number) {
  // ~8 lotes de 8 conversas por minuto + ~3 min de síntese.
  return Math.ceil(n / 64) + 3;
}

export const getAiContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { isAdmin } = await roles(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [{ data: s }, { data: ch }] = await Promise.all([
      supabaseAdmin.from("app_settings" as any).select("value").eq("key", "store_context").maybeSingle(),
      supabaseAdmin.from("channels").select("id, name").order("name"),
    ]);
    return {
      isAdmin,
      storeContext: ((s as any)?.value?.text as string) ?? "",
      channels: (ch ?? []) as { id: string; name: string }[],
    };
  });

export const previewAiAnalysis = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v) => filtersSchema.parse(v))
  .handler(async ({ data, context }) => {
    await roles(context.userId);
    const c = await candidates(data);
    const messages = c.picked.reduce((s, x) => s + Number(x.msg_count), 0);
    return {
      conversations: c.picked.length,
      totalAvailable: c.all.length,
      messages,
      sampled: c.sampled,
      estimatedMinutes: c.picked.length ? estimate(c.picked.length) : 0,
    };
  });

async function startAnalysis(userId: string, f: AiFilters, storeContext: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const c = await candidates(f);
  if (!c.picked.length) throw new Error("Nenhuma conversa atende aos filtros.");
  await supabaseAdmin.from("app_settings" as any).upsert({
    key: "store_context", value: { text: storeContext }, updated_at: new Date().toISOString(),
  });
  const { data: a, error } = await supabaseAdmin.from("ai_analyses" as any).insert({
    created_by: userId, since: c.since, until: c.until, filters: f, store_context: storeContext || null,
    status: "queued", total_conversations: c.picked.length, sampled: c.sampled,
  }).select("id").single();
  if (error) throw new Error(error.message);
  const id = (a as any).id as string;
  for (let i = 0; i < c.picked.length; i += 500) {
    const { error: e2 } = await supabaseAdmin.from("ai_analysis_items" as any).insert(
      c.picked.slice(i, i + 500).map((x) => ({ analysis_id: id, conversation_id: x.conversation_id })),
    );
    if (e2) throw new Error(e2.message);
  }
  await supabaseAdmin.rpc("arm_ai_analysis_worker" as any);
  return { id };
}

export const createAiAnalysis = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v) => z.object({ filters: filtersSchema, storeContext: z.string().max(5000).default("") }).parse(v))
  .handler(async ({ data, context }) => {
    const { isAdmin } = await roles(context.userId);
    if (!isAdmin) throw new Error("Só administradores podem iniciar análises.");
    return startAnalysis(context.userId, data.filters, data.storeContext);
  });

export const redoAiAnalysis = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v) => z.object({ id: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const { isAdmin } = await roles(context.userId);
    if (!isAdmin) throw new Error("Só administradores podem iniciar análises.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: a } = await supabaseAdmin.from("ai_analyses" as any).select("filters, store_context").eq("id", data.id).single();
    if (!a) throw new Error("Análise não encontrada.");
    const f = filtersSchema.parse((a as any).filters);
    return startAnalysis(context.userId, f, (a as any).store_context ?? "");
  });

export const listAiAnalyses = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await roles(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.from("ai_analyses" as any)
      .select("id, created_by, since, until, status, total_conversations, processed_conversations, failed_conversations, sampled, error, created_at, finished_at")
      .order("created_at", { ascending: false }).limit(50);
    if (error) throw new Error(error.message);
    const ids = [...new Set((data ?? []).map((x: any) => x.created_by).filter(Boolean))];
    const { data: profs } = ids.length
      ? await supabaseAdmin.from("profiles").select("id, name").in("id", ids)
      : { data: [] as any[] };
    const names = new Map((profs ?? []).map((p: any) => [p.id, p.name]));
    return (data ?? []).map((x: any) => ({ ...x, created_by_name: names.get(x.created_by) ?? "—" })) as AiAnalysisRow[];
  });

export type AiAnalysisRow = {
  id: string; created_by: string | null; created_by_name: string; since: string; until: string;
  status: "queued" | "running" | "summarizing" | "done" | "error";
  total_conversations: number; processed_conversations: number; failed_conversations: number;
  sampled: boolean; error: string | null; created_at: string; finished_at: string | null;
};

export const getAiAnalysis = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v) => z.object({ id: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    await roles(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: a, error } = await supabaseAdmin.from("ai_analyses" as any)
      .select("id, since, until, status, filters, total_conversations, processed_conversations, failed_conversations, sampled, error, result_markdown, result_json, created_at")
      .eq("id", data.id).single();
    if (error) throw new Error(error.message);
    const r = a as any;
    return {
      ...r,
      result_json: r.result_json ? { sections: r.result_json.sections ?? [], banco: r.result_json.banco ?? [] } : null,
    } as {
      id: string; since: string; until: string; status: AiAnalysisRow["status"]; filters: AiFilters;
      total_conversations: number; processed_conversations: number; failed_conversations: number;
      sampled: boolean; error: string | null; result_markdown: string | null; created_at: string;
      result_json: { sections: string[]; banco: { tema: string; pergunta: string; resposta: string }[] } | null;
    };
  });

export const saveBancoAsQuickReplies = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v) => z.object({ id: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    await roles(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: a } = await supabaseAdmin.from("ai_analyses" as any).select("result_json").eq("id", data.id).single();
    const banco = ((a as any)?.result_json?.banco ?? []) as { tema: string; resposta: string }[];
    const { data: existing } = await supabaseAdmin.from("quick_replies").select("shortcut, content");
    const shortcuts = new Set((existing ?? []).map((q) => q.shortcut));
    const contents = new Set((existing ?? []).map((q) => q.content.trim()));
    const slug = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20);
    const rows: { shortcut: string; content: string; created_by: string }[] = [];
    for (const b of banco) {
      const content = b.resposta.trim();
      if (!content || contents.has(content)) continue;
      let n = 1;
      let sc = `ia-${slug(b.tema)}-${n}`;
      while (shortcuts.has(sc)) sc = `ia-${slug(b.tema)}-${++n}`;
      shortcuts.add(sc); contents.add(content);
      rows.push({ shortcut: sc, content, created_by: context.userId });
    }
    if (rows.length) {
      const { error } = await supabaseAdmin.from("quick_replies").insert(rows);
      if (error) throw new Error(error.message);
    }
    return { created: rows.length, skipped: banco.length - rows.length };
  });
