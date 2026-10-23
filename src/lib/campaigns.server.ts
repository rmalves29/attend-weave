// Motor de campanhas de disparo. O dispatcher roda dentro do cron de minuto
// (dispatch-scheduled-messages). Regras de humanização / anti-bloqueio aplicadas
// SÓ ao disparo em massa (o atendimento normal não é afetado):
//   • intervalo ALEATÓRIO entre mensagens (não fixo) — via next_send_at
//   • aquecimento: nos primeiros dias envia menos e vai subindo (chip novo)
//   • "digitando..." com delay nativo antes de cada envio
//   • teto diário como limite + janela de horário (BRT)
//   • variação de texto (spintax {oi|olá} e {nome}/{primeiro_nome})
//   • pausa automática após falhas seguidas (chip caído/banido)
// Garante o ritmo mesmo se o cron atrasar (nunca dispara em rajada).
import { ensureChatConversation } from "./uazapi-ingest.server";
import { sendTextViaUazapi, sendMediaViaUazapi } from "./uazapi-send.server";

const TZ = "America/Sao_Paulo";
const MAX_CONSECUTIVE_FAILURES = 5;
const WARMUP_FACTORS = [0.4, 0.6, 0.8, 1.0]; // dia 1,2,3,4+ da campanha

// ---------- telefones ----------

export function normalizePhone(raw: string): string | null {
  let d = String(raw).replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) return d;
  if (d.length === 10 || d.length === 11) return "55" + d;
  if (d.startsWith("55") && d.length >= 12 && d.length <= 13) return d;
  return null;
}

export type ParsedList = { phones: { phone: string; name: string | null }[]; invalid: number; duplicates: number };

export function parseRecipientList(raw: string): ParsedList {
  const seen = new Set<string>();
  const phones: { phone: string; name: string | null }[] = [];
  let invalid = 0;
  let duplicates = 0;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = t.split(/[,;\t]|\s-\s/);
    const phone = normalizePhone(m[0]);
    if (!phone) { invalid++; continue; }
    if (seen.has(phone)) { duplicates++; continue; }
    seen.add(phone);
    phones.push({ phone, name: m[1]?.trim() || null });
  }
  return { phones, invalid, duplicates };
}

// ---------- variação de texto (humanização) ----------

// Resolve spintax {a|b|c} (escolhe 1 aleatório) e os placeholders {nome}.
export function renderTemplate(tpl: string, name: string | null): string {
  let out = tpl;
  // spintax: só casa blocos COM pipe, então {nome} não é afetado
  for (let i = 0; i < 20 && /\{[^{}]*\|[^{}]*\}/.test(out); i++) {
    out = out.replace(/\{([^{}]*\|[^{}]*)\}/g, (_m, inner: string) => {
      const opts = inner.split("|");
      return opts[Math.floor(Math.random() * opts.length)];
    });
  }
  const first = (name ?? "").trim().split(/\s+/)[0] || "";
  return out
    .replace(/\{nome\}/gi, name?.trim() || "")
    .replace(/\{primeiro_nome\}/gi, first)
    .trim();
}

// ---------- ritmo / janela (BRT) ----------

function brtHour(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }).format(now));
}
function brtDateStr(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d); // YYYY-MM-DD
}
function startOfDayBRTISO(now: Date): string {
  return new Date(`${brtDateStr(now)}T00:00:00-03:00`).toISOString();
}
function dayIndexBRT(startedAtISO: string | null, now: Date): number {
  if (!startedAtISO) return 999; // sem data de início conhecida → sem limite de aquecimento
  const start = new Date(`${brtDateStr(new Date(startedAtISO))}T00:00:00-03:00`).getTime();
  const today = new Date(`${brtDateStr(now)}T00:00:00-03:00`).getTime();
  return Math.max(0, Math.round((today - start) / 86_400_000));
}

// Intervalo aleatório em torno do base (ex.: base 5min → ~3 a 8,5 min).
function randomGapMs(intervalMinutes: number): number {
  const base = Math.max(30, intervalMinutes * 60) * 1000;
  return Math.round(base * (0.6 + Math.random() * 1.1));
}
// "Digitando..." proporcional ao tamanho do texto, com jitter.
function typingDelayMs(text: string): number {
  const base = Math.min(8000, Math.max(1500, text.length * 45));
  return Math.round(base + Math.random() * 1500);
}

async function sentTodayCount(sb: any, campaignId: string, now: Date): Promise<number> {
  const { count } = await sb
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("status", "sent")
    .gte("sent_at", startOfDayBRTISO(now));
  return count ?? 0;
}

// ---------- dispatcher ----------

type DispatchStats = { campaigns: number; sent: number; failed: number; skipped: number; started: number };

// Promove campanhas agendadas cujo horário chegou (scheduled → running).
async function promoteScheduled(sb: any, now: Date): Promise<number> {
  const { data: due } = await sb
    .from("campaigns")
    .select("id, started_at")
    .eq("status", "scheduled")
    .lte("scheduled_start_at", now.toISOString())
    .limit(20);
  let n = 0;
  for (const c of (due ?? []) as any[]) {
    await sb.from("campaigns").update({
      status: "running",
      started_at: c.started_at ?? now.toISOString(),
      next_send_at: null,
    }).eq("id", c.id);
    n++;
  }
  return n;
}

export async function dispatchDueCampaigns(sb: any, opts: { maxPerRun?: number } = {}): Promise<DispatchStats> {
  const maxPerRun = opts.maxPerRun ?? 5;
  const now = new Date();
  const hour = brtHour(now);

  const started = await promoteScheduled(sb, now);

  const { data: campaigns } = await sb
    .from("campaigns")
    .select("id, channel_id, message_template, media_path, media_type, media_filename, media_mime, daily_cap, interval_minutes, window_start, window_end, last_sent_at, next_send_at, consecutive_failures, warmup_enabled, typing_enabled, started_at")
    .eq("status", "running")
    .limit(20);

  const stats: DispatchStats = { campaigns: (campaigns ?? []).length, sent: 0, failed: 0, skipped: 0, started };

  for (const c of (campaigns ?? []) as any[]) {
    if (stats.sent + stats.failed >= maxPerRun) break;

    // Janela de horário (BRT).
    if (hour < c.window_start || hour >= c.window_end) { stats.skipped++; continue; }
    // Intervalo aleatório: só envia quando passou o next_send_at.
    if (c.next_send_at && now.getTime() < new Date(c.next_send_at).getTime()) { stats.skipped++; continue; }

    // Teto diário com aquecimento (chip novo começa devagar).
    const factor = c.warmup_enabled ? WARMUP_FACTORS[Math.min(dayIndexBRT(c.started_at, now), WARMUP_FACTORS.length - 1)] : 1;
    const allowedToday = Math.max(1, Math.ceil(c.daily_cap * factor));
    if (await sentTodayCount(sb, c.id, now) >= allowedToday) { stats.skipped++; continue; }

    // Próximo destinatário pendente (menor posição).
    const { data: next } = await sb
      .from("campaign_recipients")
      .select("id, phone, name")
      .eq("campaign_id", c.id).eq("status", "pending")
      .order("position", { ascending: true }).limit(1).maybeSingle();
    if (!next) {
      await sb.from("campaigns").update({ status: "done" }).eq("id", c.id);
      continue;
    }
    // Reivindica atomicamente pra não duplicar envio.
    const { data: claimed } = await sb
      .from("campaign_recipients")
      .update({ status: "sending" })
      .eq("id", next.id).eq("status", "pending")
      .select("id");
    if (!claimed?.length) { stats.skipped++; continue; }

    const gap = randomGapMs(c.interval_minutes);
    const jid = `${next.phone}@s.whatsapp.net`;
    try {
      const ensured = await ensureChatConversation(sb, c.channel_id, { wa_chatid: jid, wa_name: next.name ?? undefined });
      const convId = ensured?.conversationId;
      if (!convId) throw new Error("não foi possível criar a conversa");
      const text = renderTemplate(c.message_template ?? "", next.name);
      const delayMs = c.typing_enabled ? typingDelayMs(text || "x".repeat(20)) : undefined;
      if (c.media_path) {
        await sendMediaViaUazapi(sb, {
          conversationId: convId, storagePath: c.media_path,
          filename: c.media_filename ?? "arquivo", mimeType: c.media_mime ?? "application/octet-stream",
          caption: text, senderAgentId: null, delayMs,
        });
      } else {
        await sendTextViaUazapi(sb, { conversationId: convId, text, senderAgentId: null, delayMs });
      }

      await sb.from("campaign_recipients").update({
        status: "sent", sent_at: now.toISOString(), conversation_id: convId, error: null,
      }).eq("id", next.id);
      await sb.from("campaigns").update({
        last_sent_at: now.toISOString(),
        next_send_at: new Date(now.getTime() + gap).toISOString(),
        sent_count: await scalarInc(sb, c.id, "sent_count"),
        consecutive_failures: 0,
      }).eq("id", c.id);
      stats.sent++;
    } catch (e) {
      const msg = (e as Error).message?.slice(0, 300) ?? "erro";
      await sb.from("campaign_recipients").update({
        status: "failed", error: msg, sent_at: now.toISOString(),
      }).eq("id", next.id);
      const fails = (c.consecutive_failures ?? 0) + 1;
      const patch: any = {
        last_sent_at: now.toISOString(),
        next_send_at: new Date(now.getTime() + gap).toISOString(),
        failed_count: await scalarInc(sb, c.id, "failed_count"),
        consecutive_failures: fails,
      };
      if (fails >= MAX_CONSECUTIVE_FAILURES) patch.status = "paused"; // chip caído/banido
      await sb.from("campaigns").update(patch).eq("id", c.id);
      stats.failed++;
      console.error("[campaigns] envio falhou:", c.id, next.phone, msg);
    }
  }
  return stats;
}

async function scalarInc(sb: any, campaignId: string, col: "sent_count" | "failed_count"): Promise<number> {
  const { data } = await sb.from("campaigns").select(col).eq("id", campaignId).single();
  return ((data?.[col] as number) ?? 0) + 1;
}
