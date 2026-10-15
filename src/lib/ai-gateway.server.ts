// Chamada ao Lovable AI Gateway (/v1/responses) com saída JSON estrita.
// Sempre em streaming (SSE) e consumida no servidor. Só servidor.
const GATEWAY = "https://ai.gateway.lovable.dev/v1/responses";
const RUN_ID_HEADER = "X-Lovable-AIG-Run-ID";

export class AiGatewayError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryable: boolean,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

type CallOpts = {
  model: string;
  instructions: string;
  input: string;
  schemaName: string;
  schema: Record<string, unknown>;
  effort?: "low" | "medium" | "high";
  maxOutputTokens?: number;
  runId?: string;
};

async function callOnce<T>(o: CallOpts): Promise<{ value: T; runId?: string }> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new AiGatewayError("LOVABLE_API_KEY ausente", 401, false);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Lovable-API-Key": apiKey,
    "X-Lovable-AIG-SDK": "fetch",
  };
  if (o.runId) headers[RUN_ID_HEADER] = o.runId;
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: o.model,
      input: [
        { role: "system", content: o.instructions },
        { role: "user", content: o.input },
      ],
      stream: true,
      store: false,
      reasoning: { effort: o.effort ?? "low", summary: "auto" },
      include: ["reasoning.encrypted_content"],
      ...(o.maxOutputTokens ? { max_output_tokens: o.maxOutputTokens } : {}),
      text: { format: { type: "json_schema", name: o.schemaName, strict: true, schema: o.schema } },
    }),
  });
  const runId = res.headers.get(RUN_ID_HEADER) ?? o.runId;
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    let msg = body.slice(0, 300);
    try { msg = JSON.parse(body)?.error?.message ?? JSON.parse(body)?.message ?? msg; } catch { /* texto */ }
    const ra = Number(res.headers.get("retry-after"));
    throw new AiGatewayError(
      `IA ${res.status}: ${msg}`,
      res.status,
      res.status === 429 || res.status >= 500,
      Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined,
    );
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let refusal = "";
  let completed = false;
  const handle = (evt: any) => {
    switch (evt?.type) {
      case "response.output_text.delta": text += evt.delta ?? ""; break;
      case "response.refusal.delta": refusal += evt.delta ?? ""; break;
      case "response.completed": completed = true; break;
      case "response.incomplete":
        throw new AiGatewayError(`Resposta incompleta: ${evt.response?.incomplete_details?.reason ?? "?"}`, 200, false);
      case "response.failed":
      case "error": {
        const e = evt.response?.error ?? evt.error ?? evt;
        throw new AiGatewayError(`IA falhou: ${e?.message ?? "erro"}`, 500, true);
      }
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data || data === "[DONE]") continue;
      let evt: any;
      try { evt = JSON.parse(data); } catch { continue; }
      handle(evt);
    }
  }
  if (refusal) throw new AiGatewayError(`IA recusou: ${refusal.slice(0, 200)}`, 200, false);
  if (!completed && !text) throw new AiGatewayError("Stream interrompido sem resposta", 502, true);
  if (!text.trim()) throw new AiGatewayError("IA devolveu resposta vazia", 200, false);
  try {
    return { value: JSON.parse(text) as T, runId: runId ?? undefined };
  } catch {
    throw new AiGatewayError("IA devolveu JSON inválido", 200, true);
  }
}

/** Chama com até 3 tentativas para 429/5xx (backoff exponencial com jitter). */
export async function callResponsesJson<T>(o: CallOpts): Promise<{ value: T; runId?: string }> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await callOnce<T>(o);
    } catch (e) {
      last = e;
      if (!(e instanceof AiGatewayError) || !e.retryable || attempt === 2) throw e;
      const wait = e.retryAfterMs ?? 2000 * 3 ** attempt + Math.random() * 1000;
      await new Promise((r) => setTimeout(r, Math.min(wait, 20_000)));
    }
  }
  throw last;
}
