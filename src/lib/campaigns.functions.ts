// Server functions das campanhas de disparo (tela Campanhas).
// O envio em si é feito pelo cron (campaigns.server.ts/dispatchDueCampaigns).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAgentOrAdmin(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  const roles = (data ?? []).map((r: any) => r.role);
  if (!roles.includes("agent") && !roles.includes("admin")) throw new Error("Sem permissão.");
  return supabaseAdmin;
}

export const createCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    name: z.string().trim().min(1).max(120),
    channelId: z.string().uuid(),
    message: z.string().trim().min(1).max(4000),
    recipientsRaw: z.string().min(1),
    dailyCap: z.number().int().min(1).max(1000).optional(),
    intervalMinutes: z.number().int().min(1).max(240).optional(),
    windowStart: z.number().int().min(0).max(23).optional(),
    windowEnd: z.number().int().min(1).max(24).optional(),
  }))
  .handler(async ({ data, context }) => {
    const supabaseAdmin = await assertAgentOrAdmin(context.userId);
    const { parseRecipientList } = await import("./campaigns.server");

    const { phones, invalid, duplicates } = parseRecipientList(data.recipientsRaw);
    if (!phones.length) throw new Error("Nenhum telefone válido na lista.");

    // canal precisa ser WhatsApp
    const { data: ch } = await supabaseAdmin
      .from("channels").select("id, type, status").eq("id", data.channelId).maybeSingle();
    if (!ch || (ch as any).type !== "whatsapp") throw new Error("Selecione um canal WhatsApp.");

    const { data: campaign, error } = await supabaseAdmin.from("campaigns" as any).insert({
      name: data.name,
      channel_id: data.channelId,
      message_template: data.message,
      status: "draft",
      total: phones.length,
      daily_cap: data.dailyCap ?? 50,
      interval_minutes: data.intervalMinutes ?? 5,
      window_start: data.windowStart ?? 8,
      window_end: data.windowEnd ?? 20,
      created_by: context.userId,
    } as any).select("id").single();
    if (error) throw new Error(error.message);

    // insere destinatários em lotes
    const rows = phones.map((p, i) => ({
      campaign_id: (campaign as any).id, position: i, phone: p.phone, name: p.name,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error: insErr } = await supabaseAdmin.from("campaign_recipients" as any).insert(rows.slice(i, i + 500) as any);
      if (insErr) throw new Error(insErr.message);
    }

    return { id: (campaign as any).id, total: phones.length, invalid, duplicates };
  });

export const listCampaigns = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAgentOrAdmin(context.userId);
    const sb = context.supabase;
    const { data } = await sb
      .from("campaigns" as any)
      .select("id, name, status, total, sent_count, failed_count, daily_cap, interval_minutes, window_start, window_end, last_sent_at, created_at, channels(name)")
      .order("created_at", { ascending: false }).limit(100);
    return (data ?? []) as any[];
  });

export const getCampaignDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    await assertAgentOrAdmin(context.userId);
    const sb = context.supabase;
    const { data: campaign } = await sb
      .from("campaigns" as any)
      .select("id, name, status, message_template, total, sent_count, failed_count, consecutive_failures, daily_cap, interval_minutes, window_start, window_end, last_sent_at, created_at, channel_id, channels(name, status)")
      .eq("id", data.id).maybeSingle();
    if (!campaign) throw new Error("Campanha não encontrada");
    const [{ count: pending }, { data: recentFailed }] = await Promise.all([
      sb.from("campaign_recipients" as any).select("id", { count: "exact", head: true }).eq("campaign_id", data.id).eq("status", "pending"),
      sb.from("campaign_recipients" as any).select("phone, error, sent_at").eq("campaign_id", data.id).eq("status", "failed").order("sent_at", { ascending: false }).limit(10),
    ]);
    return { campaign, pending: pending ?? 0, recentFailed: recentFailed ?? [] };
  });

export const setCampaignStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    id: z.string().uuid(),
    action: z.enum(["start", "pause", "resume", "cancel"]),
  }))
  .handler(async ({ data, context }) => {
    const supabaseAdmin = await assertAgentOrAdmin(context.userId);
    const { data: c } = await supabaseAdmin.from("campaigns" as any).select("id, status").eq("id", data.id).maybeSingle();
    if (!c) throw new Error("Campanha não encontrada");

    const map: Record<string, string> = { start: "running", resume: "running", pause: "paused", cancel: "canceled" };
    const next = map[data.action];
    const patch: any = { status: next };
    if (data.action === "start" || data.action === "resume") patch.consecutive_failures = 0;
    const { error } = await supabaseAdmin.from("campaigns" as any).update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true, status: next };
  });
