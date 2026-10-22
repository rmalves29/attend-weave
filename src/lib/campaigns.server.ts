// Motor de campanhas de disparo. O dispatcher roda dentro do cron de minuto
// (dispatch-scheduled-messages) e, para cada campanha "running", envia no máximo
// 1 mensagem a cada `interval_minutes`, respeitando o teto diário (`daily_cap`)
// e a janela de horário (BRT). Isso garante o ritmo mesmo se o cron atrasar
// (nunca dispara em rajada) e é resiliente a reinícios.
import { ensureChatConversation } from "./uazapi-ingest.server";
import { sendTextViaUazapi } from "./uazapi-send.server";

const TZ = "America/Sao_Paulo";
const MAX_CONSECUTIVE_FAILURES = 5; // pausa a campanha se o chip parar de enviar

// ---------- telefones ----------

/** Normaliza para dígitos com DDI 55. Retorna null se claramente inválido. */
export function normalizePhone(raw: string): string | null {
  let d = String(raw).replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2);
  // Já tem DDI 55 (12 ou 13 dígitos: 55 + DDD + 8/9)
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) return d;
  // DDD + número sem DDI (10 ou 11 dígitos) → prefixa 55
  if (d.length === 10 || d.length === 11) return "55" + d;
  // Qualquer outro comprimento com 55 já no começo e tamanho plausível
  if (d.startsWith("55") && d.length >= 12 && d.length <= 13) return d;
  return null;
}

export type ParsedList = { phones: { phone: string; name: string | null }[]; invalid: number; duplicates: number };

/** Aceita uma lista crua (telefones, opcionalmente "telefone,nome" ou "telefone nome"). */
export function parseRecipientList(raw: string): ParsedList {
  const seen = new Set<string>();
  const phones: { phone: string; name: string | null }[] = [];
  let invalid = 0;
  let duplicates = 0;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    // separa telefone de um possível nome (vírgula, ponto-e-vírgula, tab ou "- ")
    const m = t.split(/[,;\t]|\s-\s/);
    const phone = normalizePhone(m[0]);
    if (!phone) { invalid++; continue; }
    if (seen.has(phone)) { duplicates++; continue; }
    seen.add(phone);
    const name = m[1]?.trim() || null;
    phones.push({ phone, name });
  }
  return { phones, invalid, duplicates };
}

export function renderTemplate(tpl: string, name: string | null): string {
  // Preserva a formatação original (parágrafos/quebras) — só troca os
  // placeholders e apara as pontas.
  const first = (name ?? "").trim().split(/\s+/)[0] || "";
  return tpl
    .replace(/\{nome\}/gi, name?.trim() || "")
    .replace(/\{primeiro_nome\}/gi, first)
    .trim();
}

// ---------- janela / ritmo (BRT) ----------

function brtHour(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }).format(now));
}
function startOfDayBRTISO(now: Date): string {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now); // YYYY-MM-DD
  return new Date(`${ymd}T00:00:00-03:00`).toISOString();
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

type DispatchStats = { campaigns: number; sent: number; failed: number; skipped: number };

export async function dispatchDueCampaigns(sb: any, opts: { maxPerRun?: number } = {}): Promise<DispatchStats> {
  const maxPerRun = opts.maxPerRun ?? 5;
  const now = new Date();
  const hour = brtHour(now);

  const { data: campaigns } = await sb
    .from("campaigns")
    .select("id, channel_id, message_template, daily_cap, interval_minutes, window_start, window_end, last_sent_at, consecutive_failures")
    .eq("status", "running")
    .limit(20);

  const stats: DispatchStats = { campaigns: (campaigns ?? []).length, sent: 0, failed: 0, skipped: 0 };

  for (const c of (campaigns ?? []) as any[]) {
    if (stats.sent + stats.failed >= maxPerRun) break;

    // Janela de horário (BRT).
    if (hour < c.window_start || hour >= c.window_end) { stats.skipped++; continue; }
    // Espaçamento mínimo entre envios.
    if (c.last_sent_at && now.getTime() - new Date(c.last_sent_at).getTime() < c.interval_minutes * 60_000) {
      stats.skipped++; continue;
    }
    // Teto diário.
    if (await sentTodayCount(sb, c.id, now) >= c.daily_cap) { stats.skipped++; continue; }

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
    // Reivindica atomicamente (pending → sending) pra não enviar em duplicidade.
    const { data: claimed } = await sb
      .from("campaign_recipients")
      .update({ status: "sending" })
      .eq("id", next.id).eq("status", "pending")
      .select("id");
    if (!claimed?.length) { stats.skipped++; continue; }

    const jid = `${next.phone}@s.whatsapp.net`;
    try {
      const ensured = await ensureChatConversation(sb, c.channel_id, {
        wa_chatid: jid, wa_name: next.name ?? undefined,
      });
      const convId = ensured?.conversationId;
      if (!convId) throw new Error("não foi possível criar a conversa");
      const text = renderTemplate(c.message_template, next.name);
      const r = await sendTextViaUazapi(sb, { conversationId: convId, text, senderAgentId: null });

      await sb.from("campaign_recipients").update({
        status: "sent", sent_at: now.toISOString(), conversation_id: convId, error: null,
      }).eq("id", next.id);
      await sb.from("campaigns").update({
        last_sent_at: now.toISOString(),
        sent_count: await scalarInc(sb, c.id, "sent_count"),
        consecutive_failures: 0,
      }).eq("id", c.id);
      stats.sent++;
      void r;
    } catch (e) {
      const msg = (e as Error).message?.slice(0, 300) ?? "erro";
      await sb.from("campaign_recipients").update({
        status: "failed", error: msg, sent_at: now.toISOString(),
      }).eq("id", next.id);
      const fails = (c.consecutive_failures ?? 0) + 1;
      const patch: any = {
        last_sent_at: now.toISOString(),
        failed_count: await scalarInc(sb, c.id, "failed_count"),
        consecutive_failures: fails,
      };
      // Chip provavelmente banido/desconectado → pausa pra não queimar a lista.
      if (fails >= MAX_CONSECUTIVE_FAILURES) patch.status = "paused";
      await sb.from("campaigns").update(patch).eq("id", c.id);
      stats.failed++;
      console.error("[campaigns] envio falhou:", c.id, next.phone, msg);
    }
  }
  return stats;
}

// Incremento seguro lendo o valor atual (sem corrida relevante: 1 cron, baixo volume).
async function scalarInc(sb: any, campaignId: string, col: "sent_count" | "failed_count"): Promise<number> {
  const { data } = await sb.from("campaigns").select(col).eq("id", campaignId).single();
  return ((data?.[col] as number) ?? 0) + 1;
}
