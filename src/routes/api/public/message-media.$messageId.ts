import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/message-media/$messageId")({
  server: {
    handlers: {
      GET: handleMediaRequest,
      HEAD: handleMediaRequest,
    },
  },
});

async function handleMediaRequest({ request, params }: { request: Request; params: { messageId: string } }) {
  const url = new URL(request.url);
  const { verifyMediaSignature, createMediaProxyResponse } = await import("@/lib/uazapi-media.server");
  if (!verifyMediaSignature(params.messageId, url.searchParams.get("expires"), url.searchParams.get("sig"))) {
    return new Response("unauthorized", { status: 401 });
  }

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return await createMediaProxyResponse(supabaseAdmin, params.messageId, request);
  } catch (e) {
    console.error("[message-media]", (e as Error).message);
    return new Response("media unavailable", { status: 404 });
  }
}