// Backfill de histórico antigo via POST /message/history-sync da uazapi.
// Segue `next_request` até `has_more:false` (início do chat) e guarda o
// progresso em public.history_sync_state. Nunca envia mensagens a contatos.
import { ingestMessage } from "./uazapi-ingest.server";

const LOCK_MS = 2 * 60_000;
const MIN_GAP_MS = 130; // ≤ ~8 req/s por processo

export type PullResult = { added: number; hasMore: boolean; status: string; skipped?: boolean };

let lastCallAt = 0;
async function throttle() {
  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function historyFetch(token: string, body: any): Promise<{ httpStatus: number; data: any }> {
  const url = process.env.UAZAPI_URL?.replace(/\/$/, "");
  if (!url) throw new Error("UAZAPI_URL não configurada");
  await throttle();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 28_000);
  try {
    const res = await fetch(`${url}/message/history-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: any = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* texto */ }
    return { httpStatus: res.status, data };
  } catch (e: any) {
    if (e?.name === "AbortError") return { httpStatus: 0, data: { status: "timeout" } };
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function chatJidFor(contact: any): string | null {
  const jid = contact?.metadata?.whatsapp?.remote_jid;
  if (jid && typeof jid === "string" && !jid.includes("@lid")) return jid;
  const phone = String(contact?.phone ?? "");
  if (!phone) return jid ?? null;
  if (phone.includes("@")) return phone;
  return `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
}

export async function enqueueHistory(sb: any, conversationId: string, channelId: string, chatJid: string) {
  await sb.from("history_sync_state").upsert(
    { conversation_id: conversationId, channel_id: channelId, chat_jid: chatJid },
    { onConflict: "conversation_id", ignoreDuplicates: true },
  );
}

const BLOCK_CODES = ["blocked", "history_access_unavailable"];
const ERROR_CODES = ["pagination_no_progress", "anchor_unavailable", "cursor_lookup_failed"];

function errorCode(data: any): string | null {
  const raw = [data?.error, data?.code, data?.reason, data?.status, data?.history_access]
    .filter((x) => typeof x === "string").join(" ").toLowerCase();
  for (const c of [...BLOCK_CODES, ...ERROR_CODES]) if (raw.includes(c)) return c;
  return null;
}

/** Aplica um resultado (resposta síncrona ou evento `status` do webhook) ao estado. */
export async function applyHistoryStatus(sb: any, conversationId: string, data: any, extra: Record<string, any> = {}) {
  const code = errorCode(data);
  const patch: any = { last_activity_at: new Date().toISOString(), ...extra };
  if (data?.history_access === false || (code && BLOCK_CODES.includes(code))) {
    patch.status = "blocked"; patch.has_more = false; patch.next_request = null;
    patch.last_error = code ?? "history_access_unavailable";
  } else if (code && ERROR_CODES.includes(code)) {
    patch.status = "error"; patch.last_error = code;
  } else if (data?.has_more === false) {
    patch.status = "done"; patch.has_more = false; patch.next_request = null; patch.last_error = null;
  } else {
    patch.status = "pending";
    if (data?.next_request) patch.next_request = data.next_request;
    if (data?.has_more === true) patch.has_more = true;
  }
  await sb.from("history_sync_state").update(patch).eq("conversation_id", conversationId);
  return patch.status as string;
}

export async function pullOlderHistory(
  sb: any,
  conversationId: string,
  opts: { pages?: number; deadline?: number } = {},
): Promise<PullResult> {
  const pages = opts.pages ?? 1;
  const deadline = opts.deadline ?? Date.now() + 25_000;

  const { data: conv } = await sb
    .from("conversations")
    .select("id, channel_id, contacts(phone, metadata), channels(type, credentials)")
    .eq("id", conversationId)
    .single();
  if (!conv) throw new Error("Conversa não encontrada");
  const token = (conv.channels as any)?.credentials?.token;
  if ((conv.channels as any)?.type !== "whatsapp" || !token) {
    return { added: 0, hasMore: false, status: "blocked" };
  }
  const jid = chatJidFor(conv.contacts);
  if (!jid) return { added: 0, hasMore: false, status: "blocked" };

  await enqueueHistory(sb, conversationId, conv.channel_id, jid);
  const { data: state } = await sb
    .from("history_sync_state").select("*").eq("conversation_id", conversationId).single();
  if (!state) throw new Error("Estado de sync indisponível");
  if (state.status === "done" || state.status === "blocked") {
    return { added: 0, hasMore: false, status: state.status };
  }
  // Lock: uma requisição ativa por chat.
  if (state.status === "running" && state.last_activity_at &&
      Date.now() - new Date(state.last_activity_at).getTime() < LOCK_MS) {
    return { added: 0, hasMore: true, status: "running", skipped: true };
  }
  const { data: locked } = await sb
    .from("history_sync_state")
    .update({ status: "running", last_activity_at: new Date().toISOString(), attempts: (state.attempts ?? 0) + 1 })
    .eq("conversation_id", conversationId)
    .eq("updated_at", state.updated_at)
    .select("conversation_id");
  if (!locked?.length) return { added: 0, hasMore: true, status: "running", skipped: true };

  let nextRequest: any = state.next_request;
  let added = 0;
  let fetched = state.fetched_count ?? 0;
  let oldest: string | null = state.oldest_message_at;
  let status = "pending";
  let hasMore = true;

  try {
    for (let page = 0; page < pages; page++) {
      if (Date.now() > deadline - 21_000 && page > 0) break;
      const requestId = crypto.randomUUID();
      const body = nextRequest
        ? { sync: true, timeoutMs: 20000, ...nextRequest }
        : { number: jid, count: 100, requestId, sync: true, timeoutMs: 20000 };

      let resp = await historyFetch(token, body);
      for (let retry = 0; (resp.httpStatus === 429 || resp.httpStatus === 409) && retry < 3; retry++) {
        await sleep(1500 * (retry + 1));
        if (resp.httpStatus === 409 && !nextRequest) body.requestId = crypto.randomUUID();
        resp = await historyFetch(token, body);
      }
      if (resp.httpStatus === 429 || resp.httpStatus === 409) {
        status = "pending";
        await sb.from("history_sync_state").update({ status: "pending", last_error: `http_${resp.httpStatus}` })
          .eq("conversation_id", conversationId);
        break;
      }
      const data = resp.data ?? {};
      if (resp.httpStatus >= 400 && !errorCode(data)) {
        throw new Error(typeof data === "string" ? data.slice(0, 200) : data?.error ?? `HTTP ${resp.httpStatus}`);
      }

      const msgs: any[] = Array.isArray(data?.messages) ? data.messages : [];
      for (const m of msgs) {
        try { if (await ingestMessage(sb, conv.channel_id, m)) added++; }
        catch (e) { console.error("[history] ingest err:", (e as Error).message); }
        const ts = Number(m?.messageTimestamp ?? m?.timestamp ?? m?.t);
        if (Number.isFinite(ts) && ts > 0) {
          const iso = new Date(ts > 1e12 ? ts : ts * 1000).toISOString();
          if (!oldest || iso < oldest) oldest = iso;
        }
      }
      fetched += msgs.length;

      status = await applyHistoryStatus(sb, conversationId, data, {
        fetched_count: fetched,
        oldest_message_at: oldest,
        request_id: body.requestId ?? data?.request_id ?? data?.requestId ?? null,
      });
      hasMore = status !== "done" && status !== "blocked";
      if (status !== "pending" || !data?.next_request) break;
      nextRequest = data.next_request;
    }
  } catch (e) {
    status = "error";
    await sb.from("history_sync_state")
      .update({ status: "error", last_error: (e as Error).message.slice(0, 300), last_activity_at: new Date().toISOString() })
      .eq("conversation_id", conversationId);
  }
  return { added, hasMore, status };
}

/** Processa a fila (chats mais recentes primeiro), concorrência máx 3. */
export async function runBackfillBatch(sb: any, opts: { deadline: number; concurrency?: number; limit?: number; channelId?: string }) {
  const lockCutoff = new Date(Date.now() - LOCK_MS).toISOString();
  let q = sb
    .from("history_sync_state")
    .select("conversation_id, status, attempts, last_activity_at, conversations(last_message_at)")
    .eq("has_more", true)
    .in("status", ["pending", "error", "running"])
    .lt("attempts", 10)
    .limit(500);
  if (opts.channelId) q = q.eq("channel_id", opts.channelId);
  const { data } = await q;
  const queue = ((data ?? []) as any[])
    .filter((r) => r.status !== "running" || !r.last_activity_at || r.last_activity_at < lockCutoff)
    .sort((a, b) => String(b.conversations?.last_message_at ?? "").localeCompare(String(a.conversations?.last_message_at ?? "")))
    .slice(0, opts.limit ?? 30);

  let processed = 0;
  let added = 0;
  const worker = async () => {
    while (queue.length && Date.now() < opts.deadline - 22_000) {
      const item = queue.shift()!;
      const r = await pullOlderHistory(sb, item.conversation_id, { pages: 5, deadline: opts.deadline });
      processed++;
      added += r.added;
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 3 }, worker));

  const { count } = await sb
    .from("history_sync_state")
    .select("conversation_id", { count: "exact", head: true })
    .eq("has_more", true)
    .in("status", ["pending", "error", "running"])
    .lt("attempts", 10);
  return { processed, added, remaining: count ?? 0 };
}
