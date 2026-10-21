// Descoberta automática de TODAS as conversas quando um número conecta.
//
// Ao conectar, o canal é marcado com history_discovery.phase = 'pending'. O cron
// history-backfill chama runDiscoveryStep(), que lista todos os chats individuais
// (/chat/find) e grupos (/group/list) da instância, cria a conversa de cada um
// (ensureChatConversation) e enfileira o chat no backfill de histórico
// (enqueueHistory → history_sync_state). O backfill então puxa o histórico
// ilimitado de cada chat, do mais recente ao começo da conversa.
//
// A descoberta é resumível: cada passada é limitada por tempo e guarda um cursor
// em channels.history_discovery. Nada é enviado a contatos — só leitura.
import { ensureChatConversation } from "./uazapi-ingest.server";
import { enqueueHistory } from "./uazapi-history.server";

const MIN_GAP_MS = 130; // ≤ ~8 req/s por processo (igual ao backfill)
let lastCallAt = 0;
async function throttle() {
  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

async function uazPost(baseUrl: string, token: string, path: string, body: any): Promise<any> {
  await throttle();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 28_000);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  } finally {
    clearTimeout(timer);
  }
}

export type DiscoveryCursor = { stage: "chats" | "groups"; offset: number };
export type DiscoveryResult = { cursor: DiscoveryCursor | null; enqueued: number };

const CHAT_PAGE = 100;
const GROUP_PAGE = 1000;

function chatId(chat: any): string | undefined {
  return (
    chat?.wa_chatid ?? chat?.chatid ?? chat?.JID ?? chat?.groupjid ?? chat?.jid ?? chat?.remoteJid
  );
}
function skippable(jid: string | undefined): boolean {
  if (!jid) return true;
  return jid.includes("@broadcast") || jid.includes("@newsletter") || jid === "status@broadcast";
}

async function enqueueChat(sb: any, channelId: string, chat: any): Promise<boolean> {
  const jid = chatId(chat);
  if (skippable(jid)) return false;
  const ensured = await ensureChatConversation(sb, channelId, chat);
  const convId = ensured?.conversationId;
  if (!convId) return false;
  await enqueueHistory(sb, convId, channelId, jid!);
  return true;
}

// Uma passada de descoberta para UM canal, limitada por `deadline`.
// Retorna o cursor para continuar (ou null quando terminou tudo).
export async function discoverChannelChats(
  sb: any,
  channel: { id: string; credentials: any },
  opts: { cursor?: DiscoveryCursor | null; deadline: number; maxEnqueue?: number },
): Promise<DiscoveryResult> {
  const token = (channel.credentials as any)?.token;
  const baseUrl = process.env.UAZAPI_URL?.replace(/\/$/, "");
  if (!token || !baseUrl) return { cursor: null, enqueued: 0 };

  let stage: "chats" | "groups" = opts.cursor?.stage ?? "chats";
  let offset = opts.cursor?.offset ?? 0;
  let enqueued = 0;
  // Teto por ciclo: limita sub-requisições por invocação (segurança serverless).
  // O cursor continua na próxima tick do cron. enqueueHistory ignora duplicatas.
  const maxEnqueue = opts.maxEnqueue ?? 300;
  const outOfTime = () => Date.now() > opts.deadline || enqueued >= maxEnqueue;

  // 1) Chats individuais (e qualquer chat conhecido pela instância).
  if (stage === "chats") {
    while (offset < 50_000) {
      if (outOfTime()) return { cursor: { stage: "chats", offset }, enqueued };
      let res: any;
      try {
        res = await uazPost(baseUrl, token, "/chat/find", {
          operator: "AND",
          sort: "-wa_lastMsgTimestamp",
          limit: CHAT_PAGE,
          offset,
        });
      } catch {
        return { cursor: { stage: "chats", offset }, enqueued };
      }
      const page: any[] = Array.isArray(res) ? res : (res?.chats ?? res?.data ?? []);
      if (!page.length) break;
      for (const chat of page) {
        try {
          if (await enqueueChat(sb, channel.id, chat)) enqueued++;
        } catch (e) {
          console.error("[discovery] enqueue chat err:", (e as Error).message);
        }
      }
      const next = offset + page.length;
      const total = Number(res?.pagination?.totalRecords);
      if (next <= offset) break;
      offset = next;
      if (Number.isFinite(total) && offset >= total) break;
      if (page.length < CHAT_PAGE) break;
    }
    stage = "groups";
    offset = 0;
  }

  // 2) Grupos (fonte explícita; /chat/find pode não trazer todos).
  if (stage === "groups") {
    while (offset < 50_000) {
      if (outOfTime()) return { cursor: { stage: "groups", offset }, enqueued };
      let res: any;
      try {
        res = await uazPost(baseUrl, token, "/group/list", {
          limit: GROUP_PAGE,
          offset,
          force: offset === 0,
          noParticipants: true,
        });
      } catch {
        break;
      } // grupos são best-effort; não trava a descoberta
      const groups: any[] = Array.isArray(res)
        ? res
        : (res?.groups ?? res?.data?.groups ?? res?.data ?? []);
      if (!groups.length) break;
      for (const group of groups) {
        const groupJid = group?.JID ?? group?.jid ?? group?.groupjid ?? group?.id;
        if (!groupJid) continue;
        try {
          if (
            await enqueueChat(sb, channel.id, {
              ...group,
              wa_chatid: groupJid,
              wa_isGroup: true,
              wa_name: group?.Name ?? group?.name ?? group?.subject ?? "",
            })
          )
            enqueued++;
        } catch (e) {
          console.error("[discovery] enqueue group err:", (e as Error).message);
        }
      }
      const next = offset + groups.length;
      const total = Number(res?.pagination?.totalRecords);
      if (next <= offset) break;
      offset = next;
      if (Number.isFinite(total) && offset >= total) break;
      if (groups.length < GROUP_PAGE) break;
    }
  }

  return { cursor: null, enqueued }; // terminou tudo
}

// Processa a descoberta pendente de 1 canal por vez (geralmente só há um número).
// Retorna se ainda há canal em descoberta — o cron mantém-se armado enquanto sim.
export async function runDiscoveryStep(
  sb: any,
  opts: { deadline: number },
): Promise<{ stillDiscovering: boolean; didWork: boolean; enqueued: number }> {
  const { data: channels } = await sb
    .from("channels")
    .select("id, credentials, history_discovery")
    .eq("type", "whatsapp")
    .not("history_discovery", "is", null)
    .limit(20);

  const pending = ((channels ?? []) as any[]).filter((c) =>
    ["pending", "running"].includes(c.history_discovery?.phase),
  );
  if (!pending.length) return { stillDiscovering: false, didWork: false, enqueued: 0 };

  let enqueued = 0;
  let stillDiscovering = false;
  let progressed = false; // houve avanço real? (senão, não trava o backfill)
  for (const ch of pending) {
    if (Date.now() > opts.deadline) {
      stillDiscovering = true;
      break;
    }
    const disc = ch.history_discovery ?? {};
    await sb
      .from("channels")
      .update({
        history_discovery: { ...disc, phase: "running" },
      } as any)
      .eq("id", ch.id);

    let result: DiscoveryResult;
    try {
      result = await discoverChannelChats(sb, ch, {
        cursor: disc.cursor ?? null,
        deadline: opts.deadline,
      });
    } catch (e) {
      console.error("[discovery] canal falhou:", ch.id, (e as Error).message);
      stillDiscovering = true; // continua pendente; tenta de novo na próxima tick
      continue;
    }
    enqueued += result.enqueued;
    progressed = true;

    if (result.cursor) {
      stillDiscovering = true;
      await sb
        .from("channels")
        .update({
          history_discovery: {
            ...disc,
            phase: "running",
            cursor: result.cursor,
            enqueued: (disc.enqueued ?? 0) + result.enqueued,
          },
        } as any)
        .eq("id", ch.id);
    } else {
      await sb
        .from("channels")
        .update({
          history_discovery: {
            ...disc,
            phase: "done",
            cursor: null,
            enqueued: (disc.enqueued ?? 0) + result.enqueued,
            finished_at: new Date().toISOString(),
          },
        } as any)
        .eq("id", ch.id);
    }
  }

  // Armou o backfill: as novas conversas enfileiradas precisam ser puxadas.
  if (enqueued > 0) {
    try {
      await sb.rpc("arm_history_backfill");
    } catch {
      /* best-effort */
    }
  }
  // didWork só quando houve avanço real; se todos os canais erraram, deixa o
  // backfill rodar normalmente (stillDiscovering mantém o cron armado p/ retry).
  return { stillDiscovering, didWork: progressed, enqueued };
}

// Marca um canal para descoberta automática e arma o cron.
// Idempotente: reconectar re-descobre sem duplicar (enqueueHistory ignora dups).
export async function startAutoHistory(sb: any, channelId: string): Promise<void> {
  await sb
    .from("channels")
    .update({
      history_discovery: { phase: "pending", cursor: null, started_at: new Date().toISOString() },
    } as any)
    .eq("id", channelId);
  try {
    await sb.rpc("arm_history_backfill");
  } catch {
    /* best-effort */
  }
}
