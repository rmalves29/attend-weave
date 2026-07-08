import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// ---------- helpers ----------
function getUazapiConfig() {
  const url = process.env.UAZAPI_URL?.replace(/\/$/, "");
  const adminToken = process.env.UAZAPI_ADMIN_TOKEN;
  if (!url || !adminToken) {
    throw new Error(
      "uazapi não configurada. Adicione os secrets UAZAPI_URL e UAZAPI_ADMIN_TOKEN.",
    );
  }
  return { url, adminToken };
}

async function uazapiFetch(
  path: string,
  opts: { token?: string; admin?: boolean; method?: string; body?: unknown } = {},
) {
  const { url, adminToken } = getUazapiConfig();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.admin) headers["admintoken"] = adminToken;
  if (opts.token) headers["token"] = opts.token;

  const res = await fetch(`${url}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) {
    const msg = typeof data === "string" ? data : data?.error ?? data?.message ?? `HTTP ${res.status}`;
    throw new Error(`uazapi: ${msg}`);
  }
  return data;
}

async function assertAdmin(ctx: { supabase: any; userId: string }) {
  const { data, error } = await ctx.supabase.rpc("has_role", {
    _user_id: ctx.userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Apenas administradores podem gerenciar canais.");
}

function webhookUrlFor(channelId: string) {
  const base =
    process.env.PUBLIC_APP_URL?.replace(/\/$/, "") ??
    "https://attend-weave.lovable.app";
  return `${base}/api/public/uazapi-webhook/${channelId}`;
}

// ---------- create ----------
export const createUazapiInstance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ name: z.string().min(1).max(60) }))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);

    // 1. cria instância na uazapi (admintoken)
    const created = await uazapiFetch("/instance/init", {
      admin: true,
      body: { name: data.name, systemName: "AttendFlow" },
    });
    const instanceToken: string =
      created?.token ?? created?.instance?.token ?? created?.data?.token;
    const instanceId: string =
      created?.id ?? created?.instance?.id ?? created?.data?.id ?? data.name;
    if (!instanceToken) throw new Error("Token da instância não retornado pela uazapi.");

    // 2. salva no banco
    const { data: channel, error } = await context.supabase
      .from("channels")
      .insert({
        name: data.name,
        type: "whatsapp",
        status: "disconnected",
        identifier: instanceId,
        credentials: { provider: "uazapi", token: instanceToken, instance_id: instanceId },
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    // 3. configura webhook (best-effort — não bloqueia se falhar)
    try {
      await uazapiFetch("/webhook", {
        token: instanceToken,
        body: {
          url: webhookUrlFor(channel.id),
          enabled: true,
          events: ["messages", "messages_update", "connection", "qrcode"],
          excludeMessages: [],
          addUrlEvents: false,
        },
      });
    } catch (e) {
      console.warn("[uazapi] webhook setup falhou:", (e as Error).message);
    }

    return { channelId: channel.id };
  });

// ---------- connect / QR ----------
export const connectUazapiInstance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ channelId: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { data: ch, error } = await context.supabase
      .from("channels").select("*").eq("id", data.channelId).single();
    if (error || !ch) throw new Error("Canal não encontrado");
    const token = (ch.credentials as any)?.token;
    if (!token) throw new Error("Instância sem token uazapi");

    const res = await uazapiFetch("/instance/connect", { token, body: {} });
    const qr: string | undefined = res?.instance?.qrcode ?? res?.qrcode ?? res?.qr;
    const status = res?.instance?.status ?? res?.status ?? "connecting";

    await context.supabase
      .from("channels")
      .update({ qr_code: qr ?? null, status: status === "connected" ? "connected" : "connecting" })
      .eq("id", data.channelId);

    return { qr, status };
  });

// ---------- status polling ----------
export const getUazapiStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ channelId: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    const { data: ch, error } = await context.supabase
      .from("channels").select("*").eq("id", data.channelId).single();
    if (error || !ch) throw new Error("Canal não encontrado");
    const token = (ch.credentials as any)?.token;
    if (!token) throw new Error("Instância sem token uazapi");

    const res = await uazapiFetch("/instance/status", { token });
    const raw = res?.instance?.status ?? res?.status ?? "disconnected";
    const mapped =
      raw === "connected" ? "connected"
      : raw === "connecting" ? "connecting"
      : raw === "disconnected" ? "disconnected"
      : "error";

    const patch: any = { status: mapped };
    if (mapped === "connected") {
      patch.qr_code = null;
      patch.last_connected_at = new Date().toISOString();
      patch.identifier = res?.instance?.wid ?? res?.instance?.owner ?? ch.identifier;
    }
    await context.supabase.from("channels").update(patch).eq("id", data.channelId);
    return { status: mapped };
  });

// ---------- disconnect ----------
export const disconnectUazapiInstance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ channelId: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { data: ch } = await context.supabase
      .from("channels").select("*").eq("id", data.channelId).single();
    const token = (ch?.credentials as any)?.token;
    if (token) {
      try { await uazapiFetch("/instance/disconnect", { token, body: {} }); } catch {}
    }
    await context.supabase.from("channels")
      .update({ status: "disconnected", qr_code: null }).eq("id", data.channelId);
    return { ok: true };
  });

// ---------- delete ----------
export const deleteUazapiInstance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ channelId: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { data: ch } = await context.supabase
      .from("channels").select("*").eq("id", data.channelId).single();
    const creds = (ch?.credentials as any) ?? {};
    const token: string | undefined = creds.token;
    const instanceId: string | undefined = creds.instance_id;

    if (token) {
      try { await uazapiFetch("/instance/disconnect", { token, body: {} }); } catch {}
    }
    if (instanceId) {
      try {
        await uazapiFetch(`/instance/${encodeURIComponent(instanceId)}`, {
          admin: true, method: "DELETE",
        });
      } catch (e) {
        console.warn("[uazapi] delete remoto falhou:", (e as Error).message);
      }
    }
    const { error } = await context.supabase.from("channels").delete().eq("id", data.channelId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ---------- send message ----------
export const sendUazapiMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    channelId: z.string().uuid(),
    to: z.string().min(5),
    text: z.string().min(1),
  }))
  .handler(async ({ data, context }) => {
    const { data: ch, error } = await context.supabase
      .from("channels").select("*").eq("id", data.channelId).single();
    if (error || !ch) throw new Error("Canal não encontrado");
    const token = (ch.credentials as any)?.token;
    if (!token) throw new Error("Instância sem token uazapi");

    const res = await uazapiFetch("/send/text", {
      token,
      body: { number: data.to, text: data.text },
    });
    return { ok: true, id: res?.messageid ?? res?.id ?? null };
  });
