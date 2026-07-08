import { createHash, createHmac, randomUUID, timingSafeEqual } from "crypto";

type SupabaseAdmin = any;

type StoredMedia = {
  storagePath: string;
  mimeType: string;
  filename: string | null;
};

function getUazapiConfig() {
  const url = process.env.UAZAPI_URL?.replace(/\/$/, "");
  const adminToken = process.env.UAZAPI_ADMIN_TOKEN;
  if (!url || !adminToken) throw new Error("uazapi não configurada.");
  return { url, adminToken };
}

async function uazapiFetch(
  path: string,
  opts: { token?: string; admin?: boolean; method?: string; body?: unknown } = {},
) {
  const { url, adminToken } = getUazapiConfig();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.admin) headers.admintoken = adminToken;
  if (opts.token) headers.token = opts.token;

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

function getSigningSecret() {
  const secret = process.env.UAZAPI_ADMIN_TOKEN ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("Assinatura de mídia indisponível");
  return secret;
}

export function signMediaUrlPath(messageId: string, ttlSeconds = 6 * 60 * 60) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = createHmac("sha256", getSigningSecret())
    .update(`${messageId}.${expires}`)
    .digest("hex");
  return `/api/public/message-media/${encodeURIComponent(messageId)}?expires=${expires}&sig=${sig}`;
}

export function verifyMediaSignature(messageId: string, expiresRaw: string | null, sig: string | null) {
  const expires = Number(expiresRaw);
  if (!expires || !sig || expires < Math.floor(Date.now() / 1000)) return false;
  const expected = createHmac("sha256", getSigningSecret())
    .update(`${messageId}.${expires}`)
    .digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function extractShortId(externalId: string | null, metadata: any): string | undefined {
  const raw = metadata?.raw ?? {};
  return raw?.messageid ?? raw?.messageId ?? raw?.id ??
    (externalId?.includes(":") ? externalId.split(":").pop()! : externalId ?? undefined);
}

function pushUnique(list: string[], value: unknown) {
  if (typeof value === "string" && value.trim() && !list.includes(value.trim())) {
    list.push(value.trim());
  }
}

function pickFirst(obj: any, paths: string[][]) {
  for (const path of paths) {
    let cur = obj;
    for (const key of path) cur = cur?.[key];
    if (cur !== undefined && cur !== null && cur !== "") return cur;
  }
  return undefined;
}

function mimeFallback(messageType: string | null | undefined) {
  if (messageType === "image") return "image/jpeg";
  if (messageType === "audio") return "audio/ogg";
  if (messageType === "video") return "video/mp4";
  if (messageType === "document") return "application/octet-stream";
  return "application/octet-stream";
}

function normalizeMime(value: unknown, messageType?: string | null) {
  return (typeof value === "string" && value.includes("/")) ? value : mimeFallback(messageType);
}

function extensionFor(mimeType: string, filename?: string | null) {
  const named = filename?.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (named && named.length <= 8) return named;
  const clean = mimeType.split(";", 1)[0].toLowerCase();
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "application/pdf": "pdf",
  };
  return map[clean] ?? clean.split("/").pop()?.replace(/[^a-z0-9]/gi, "") ?? "bin";
}

function filenameFor(messageId: string, mimeType: string, original?: string | null) {
  if (original) return original;
  return `midia-${messageId.slice(0, 8)}.${extensionFor(mimeType)}`;
}

function cleanBase64(value: string) {
  return value.includes(",") ? value.split(",", 2)[1] : value;
}

function isProbablyUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

async function fetchRemoteBytes(url: string, token?: string) {
  const attempts: RequestInit[] = [
    {},
    token ? { headers: { token } } : {},
    token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  ];
  let lastErr = "";
  for (const init of attempts) {
    if (Object.keys(init).length === 0 && attempts.indexOf(init) > 0) continue;
    try {
      const res = await fetch(url, init);
      const contentType = res.headers.get("content-type") ?? "application/octet-stream";
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      if (/text\/html|application\/json/i.test(contentType)) {
        const text = await res.text();
        lastErr = text.slice(0, 160) || contentType;
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.byteLength) {
        lastErr = "arquivo vazio";
        continue;
      }
      return { bytes, contentType };
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  throw new Error(lastErr || "URL da mídia indisponível");
}

async function uploadMedia(
  supabaseAdmin: SupabaseAdmin,
  messageId: string,
  bytes: Uint8Array,
  mimeType: string,
  filename: string | null,
) {
  const ext = extensionFor(mimeType, filename);
  const digest = createHash("sha1").update(bytes).digest("hex").slice(0, 12);
  const path = `messages/${messageId}/${digest || randomUUID()}.${ext}`;
  const { error } = await supabaseAdmin.storage
    .from("attachments")
    .upload(path, bytes, { contentType: mimeType, upsert: true });
  if (error) throw new Error(`Falha ao salvar mídia: ${error.message}`);
  return path;
}

async function storeAndPatch(
  supabaseAdmin: SupabaseAdmin,
  msg: any,
  meta: any,
  media: any,
  bytes: Uint8Array,
  mimeType: string,
  filename: string | null,
  extra: Record<string, unknown> = {},
): Promise<StoredMedia> {
  const safeFilename = filenameFor(msg.id, mimeType, filename ?? media.filename ?? media.fileName ?? null);
  const storagePath = await uploadMedia(supabaseAdmin, msg.id, bytes, mimeType, safeFilename);
  await supabaseAdmin.from("messages").update({
    metadata: {
      ...meta,
      media: {
        ...media,
        ...extra,
        storagePath,
        mimeType,
        mimetype: mimeType,
        filename: safeFilename,
        cachedAt: new Date().toISOString(),
      },
    },
  }).eq("id", msg.id);
  return { storagePath, mimeType, filename: safeFilename };
}

function directUrlCandidates(media: any, raw: any, dl?: any) {
  const urls: string[] = [];
  for (const value of [
    media?.cachedUrl,
    media?.url,
    media?.fileURL,
    media?.fileUrl,
    media?.mediaUrl,
    raw?.content?.fileURL,
    raw?.content?.fileUrl,
    raw?.content?.mediaUrl,
    raw?.content?.url,
    raw?.fileURL,
    raw?.fileUrl,
    raw?.mediaUrl,
    raw?.url,
    dl?.fileURL,
    dl?.fileUrl,
    dl?.mediaUrl,
    dl?.url,
    dl?.data?.fileURL,
    dl?.data?.fileUrl,
    dl?.data?.mediaUrl,
    dl?.data?.url,
  ]) pushUnique(urls, value);
  return urls.filter(isProbablyUrl);
}

function base64Candidates(dl: any) {
  const values: string[] = [];
  for (const value of [
    dl?.fileBase64,
    dl?.base64,
    dl?.media,
    dl?.file,
    dl?.data?.fileBase64,
    dl?.data?.base64,
    dl?.data?.media,
    dl?.data?.file,
    typeof dl?.data === "string" ? dl.data : undefined,
  ]) pushUnique(values, value);
  return values;
}

export async function resolveMessageMediaToStorage(
  supabaseAdmin: SupabaseAdmin,
  messageId: string,
): Promise<StoredMedia> {
  const { data: msg, error } = await supabaseAdmin
    .from("messages")
    .select("id, type, external_id, metadata, conversations(channels(credentials))")
    .eq("id", messageId)
    .single();
  if (error || !msg) throw new Error("Mensagem não encontrada");

  const meta = msg.metadata ?? {};
  const media = meta.media ?? {};
  const raw = meta.raw ?? {};
  const storedMime = normalizeMime(media.mimeType ?? media.mimetype ?? raw?.content?.mimetype, msg.type);
  const storedFilename = media.filename ?? media.fileName ?? raw?.content?.fileName ?? null;
  if (media.storagePath) {
    return { storagePath: media.storagePath, mimeType: storedMime, filename: storedFilename };
  }

  const token = (msg as any).conversations?.channels?.credentials?.token as string | undefined;

  let lastErr = "";
  for (const url of directUrlCandidates(media, raw)) {
    try {
      const remote = await fetchRemoteBytes(url, token);
      const mimeType = normalizeMime(remote.contentType || storedMime, msg.type);
      return await storeAndPatch(supabaseAdmin, msg, meta, media, remote.bytes, mimeType, storedFilename, { sourceUrl: url });
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }

  if (!token) throw new Error("Canal sem token para baixar mídia");

  const candidateIds: string[] = [];
  pushUnique(candidateIds, raw?.messageid);
  pushUnique(candidateIds, raw?.messageId);
  pushUnique(candidateIds, raw?.id);
  pushUnique(candidateIds, raw?.key?.id);
  pushUnique(candidateIds, msg.external_id);
  const shortId = extractShortId(msg.external_id, meta);
  pushUnique(candidateIds, shortId);

  const endpoints = ["/message/download", "/message/downloadmedia"];
  const bodyFor = (id: string) => [
    { id },
    { messageid: id },
    { messageId: id },
    { id, base64: true },
    { messageid: id, base64: true },
    { messageId: id, base64: true },
  ];

  for (const endpoint of endpoints) {
    for (const id of candidateIds) {
      for (const body of bodyFor(id)) {
        let dl: any;
        try {
          dl = await uazapiFetch(endpoint, { token, body });
        } catch (e) {
          lastErr = (e as Error).message;
          continue;
        }

        const dlMime = normalizeMime(
          pickFirst(dl, [["mimetype"], ["mimeType"], ["data", "mimetype"], ["data", "mimeType"]]) ?? storedMime,
          msg.type,
        );
        const dlFilename = pickFirst(dl, [["fileName"], ["filename"], ["data", "fileName"], ["data", "filename"]]) ?? storedFilename;

        for (const url of directUrlCandidates(media, raw, dl)) {
          try {
            const remote = await fetchRemoteBytes(url, token);
            const mimeType = normalizeMime(remote.contentType || dlMime, msg.type);
            return await storeAndPatch(supabaseAdmin, msg, meta, media, remote.bytes, mimeType, dlFilename, { sourceUrl: url });
          } catch (e) {
            lastErr = (e as Error).message;
          }
        }

        for (const b64 of base64Candidates(dl)) {
          try {
            const bytes = new Uint8Array(Buffer.from(cleanBase64(b64), "base64"));
            if (!bytes.byteLength) throw new Error("base64 vazio");
            return await storeAndPatch(supabaseAdmin, msg, meta, media, bytes, dlMime, dlFilename);
          } catch (e) {
            lastErr = (e as Error).message;
          }
        }
      }
    }
  }

  throw new Error(`Mídia indisponível${lastErr ? `: ${lastErr}` : ""}`);
}

function contentDisposition(filename: string | null) {
  if (!filename) return "inline";
  const safe = filename.replace(/["\\\r\n]/g, "_");
  return `inline; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function createMediaProxyResponse(
  supabaseAdmin: SupabaseAdmin,
  messageId: string,
  request: Request,
) {
  const media = await resolveMessageMediaToStorage(supabaseAdmin, messageId);
  const { data, error } = await supabaseAdmin.storage
    .from("attachments")
    .createSignedUrl(media.storagePath, 60 * 5);
  if (error || !data?.signedUrl) throw new Error("Falha ao preparar mídia");

  const headers: HeadersInit = {};
  const range = request.headers.get("range");
  if (range) headers.Range = range;
  const upstream = await fetch(data.signedUrl, { headers, method: request.method === "HEAD" ? "HEAD" : "GET" });

  const out = new Headers();
  out.set("content-type", upstream.headers.get("content-type") ?? media.mimeType);
  out.set("content-disposition", contentDisposition(media.filename));
  out.set("accept-ranges", upstream.headers.get("accept-ranges") ?? "bytes");
  out.set("cache-control", "private, max-age=300");
  for (const h of ["content-length", "content-range", "etag", "last-modified"]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }

  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}