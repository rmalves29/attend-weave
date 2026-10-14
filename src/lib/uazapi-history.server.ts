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

function historyFetch(token: string, body: any) {
  return uazapiPost(token, "/message/history-sync", body);
}

async function uazapiPost(token: string, path: string, body: any): Promise<{ httpStatus: number; data: any }> {
  const url = process.env.UAZAPI_URL?.replace(/\/$/, "");
  if (!url) throw new Error("UAZAPI_URL não configurada");
  await throttle();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 28_000);
  try {
    const res = await fetch(`${url}${path}`, {
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
  if (jid && typeof jid === "string" && (jid.endsWith("@lid") || !jid.includes("@lid"))) return jid;
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

const BLOCK_CODES = ["sem_ancora", "blocked", "history_access_unavailable"];
const ERROR_CODES = ["pagination_no_progress", "anchor_unavailable", "cursor_lookup_failed"];

function errorCode(data: any): string | null {
  const raw = [typeof data === "string" ? data : null, data?.error, data?.message, data?.code, data?.reason, data?.status, data?.history_access]
    .filter((x) => typeof x === "string").join(" ").toLowerCase();
  if (raw.includes("no anchor")) return "sem_ancora";
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
    // Sem next_request: a próxima rodada recua usando a mensagem mais antiga que temos.
    patch.next_request = data?.next_request ?? null;
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

  let added = 0;
  let fetched = state.fetched_count ?? 0;
  let oldest: string | null = state.oldest_message_at;
  let status = "pending";
  let hasMore = true;
  let emptyRounds = state.empty_rounds ?? 0;

  const ingestAll = async (msgs: any[]) => {
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
  };

  try {
    // 1) Coleta o que chegou depois para o request_id da rodada anterior.
    let foundPrev = 0;
    if (state.request_id) {
      let offset = 0;
      for (let i = 0; i < 20; i++) {
        const r = await uazapiPost(token, "/message/find", {
          track_source: "history_sync_manual", track_id: state.request_id, limit: 1000, offset,
        });
        const d = r.data ?? {};
        const msgs: any[] = Array.isArray(d?.messages) ? d.messages : Array.isArray(d) ? d : [];
        await ingestAll(msgs);
        foundPrev += msgs.length;
        const pg = d?.pagination;
        if (r.httpStatus >= 400 || !pg?.hasMore || pg?.nextOffset == null || !msgs.length) break;
        offset = Number(pg.nextOffset);
      }
      if (foundPrev > 0) {
        await sb.from("history_sync_state").update({
          fetched_count: fetched, oldest_message_at: oldest, attempts: 0,
          last_activity_at: new Date().toISOString(),
        }).eq("conversation_id", conversationId);
      }
    }

    for (let page = 0; page < pages; page++) {
      if (Date.now() > deadline - 21_000 && page > 0) break;
      const requestId = crypto.randomUUID();
      // Âncora: a mensagem mais antiga que temos (ou agora, se nenhuma).
      const { data: oldestMsg } = await sb.from("messages")
        .select("external_id, created_at, direction").eq("conversation_id", conversationId)
        .not("external_id", "is", null)
        .order("created_at", { ascending: true }).limit(1).maybeSingle();
      const body: any = { number: jid, count: 100, requestId, sync: true, timeoutMs: 20000 };
      if (oldestMsg?.external_id) {
        body.messageid = oldestMsg.external_id;
        body.fromMe = oldestMsg.direction === "outbound";
        body.timestamp = Math.floor(new Date(oldestMsg.created_at).getTime() / 1000);
      } else {
        body.timestamp = Math.floor(Date.now() / 1000);
      }

      let resp = await historyFetch(token, body);
      for (let retry = 0; (resp.httpStatus === 429 || resp.httpStatus === 409) && retry < 3; retry++) {
        await sleep(1500 * (retry + 1));
        if (resp.httpStatus === 409) body.requestId = crypto.randomUUID();
        resp = await historyFetch(token, body);
      }
      // Âncora inválida ("not found locally" ou "is not a valid history sync anchor"):
      // tenta uma vez só com timestamp; se persistir, ancora na mensagem mais antiga seguinte (offset 1..3).
      const isAnchorErr = (r: { httpStatus: number; data: any }) => {
        const t = (typeof r.data === "string" ? r.data : `${r.data?.error ?? ""} ${r.data?.message ?? ""}`).toLowerCase();
        return t.includes("not found locally") || (r.httpStatus >= 400 && t.includes("is not a valid history sync anchor"));
      };
      if (body.messageid && isAnchorErr(resp)) {
        delete body.messageid; delete body.fromMe;
        body.requestId = crypto.randomUUID();
        resp = await historyFetch(token, body);
        for (let offset = 1; offset <= 3 && isAnchorErr(resp); offset++) {
          const { data: olderMsg } = await sb.from("messages")
            .select("external_id, created_at, direction").eq("conversation_id", conversationId)
            .not("external_id", "is", null)
            .order("created_at", { ascending: true })
            .range(offset, offset)
            .maybeSingle();
          if (!olderMsg?.external_id) break;
          body.messageid = olderMsg.external_id;
          body.fromMe = olderMsg.direction === "outbound";
          body.timestamp = Math.floor(new Date(olderMsg.created_at).getTime() / 1000);
          body.requestId = crypto.randomUUID();
          resp = await historyFetch(token, body);
        }
      }
      if (resp.httpStatus === 429 || resp.httpStatus === 409) {
        status = "pending";
        await sb.from("history_sync_state").update({ status: "pending", last_error: `http_${resp.httpStatus}` })
          .eq("conversation_id", conversationId);
        break;
      }
      const data = resp.data ?? {};
      const msgs: any[] = Array.isArray(data?.messages) ? data.messages : [];
      const details = (data && typeof data === "object" && data.details) || {};

      // Diagnóstico: guarda o que a uazapi respondeu (nunca o token).
      try {
        const { token: _t, ...bodySent } = body ?? {};
        const isObj = data && typeof data === "object";
        let raw = "";
        try { raw = (typeof data === "string" ? data : JSON.stringify(data)).slice(0, 1500); } catch { /* */ }
        if (token) raw = raw.split(token).join("[redacted]");
        await sb.from("history_sync_state").update({
          last_response: {
            http: resp.httpStatus,
            body_sent: bodySent,
            keys: isObj ? Object.keys(data) : [],
            status: isObj ? data.status ?? null : null,
            has_more: isObj ? data.has_more ?? null : null,
            history_access: isObj ? data.history_access ?? null : null,
            n_messages: msgs.length,
            next_request: isObj ? data.next_request ?? null : null,
            error: isObj ? data.error ?? data.message ?? null : null,
            raw,
          },
        }).eq("conversation_id", conversationId);
      } catch (e) { console.error("[history] last_response err:", (e as Error).message); }

      if (resp.httpStatus >= 400 && !errorCode(data)) {
        throw new Error(typeof data === "string" ? data.slice(0, 200) : data?.error ?? data?.message ?? `HTTP ${resp.httpStatus}`);
      }

      await ingestAll(msgs);
      const received = Number(details.received_messages ?? data?.received ?? 0) || 0;
      const progress = msgs.length > 0 || received > 0 || foundPrev > 0;
      if (resp.httpStatus === 200 && !progress) emptyRounds++;
      else if (progress) emptyRounds = 0;

      const reqId = data?.request_id ?? body.requestId;
      const finished =
        (details.pending_more === false && received === 0 && msgs.length === 0 && foundPrev === 0) ||
        emptyRounds >= 3;

      const extra: Record<string, any> = {
        ...(progress ? { attempts: 0 } : {}),
        fetched_count: fetched,
        oldest_message_at: oldest,
        request_id: reqId ?? null,
        empty_rounds: emptyRounds,
      };
      if (finished) {
        await applyHistoryStatus(sb, conversationId, { has_more: false }, extra);
        await sb.from("history_sync_state").update({ last_error: "sem_mais_historico" })
          .eq("conversation_id", conversationId);
        status = "done";
      } else {
        // timed_out/partial/202: fica pending; a próxima rodada coleta via /message/find.
        status = await applyHistoryStatus(sb, conversationId, data, extra);
      }
      hasMore = status !== "done" && status !== "blocked";
      // Mensagens do request atual chegam depois; não encadeia outro sync agora.
      break;
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
export async function runBackfillBatch(sb: any, opts: { deadline: number; concurrency?: number; limit?: number; channelId?: string; pages?: number; reserveMs?: number }) {
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
    while (queue.length && Date.now() < opts.deadline - (opts.reserveMs ?? 22_000)) {
      const item = queue.shift()!;
      const r = await pullOlderHistory(sb, item.conversation_id, { pages: opts.pages ?? 5, deadline: opts.deadline + 21_000 - (opts.reserveMs ?? 22_000) + 1_000 });
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
