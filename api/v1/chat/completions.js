const DEFAULT_MODEL = "z-ai/glm-5.1";
const DEFAULT_UPSTREAM = "https://ai.hackclub.com/proxy/v1/chat/completions";

export const config = {
  runtime: "edge",
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  const apiKey = process.env.HACK_CLUB_AI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Server misconfigured" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  const payload = {
    ...body,
    model: body?.model || DEFAULT_MODEL,
  };

  const upstreamUrl = process.env.HACKCLUB_BASE_URL || DEFAULT_UPSTREAM;
  const upstreamRes = await fetch(upstreamUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const responseHeaders = new Headers(upstreamRes.headers);
  for (const [k, v] of Object.entries(corsHeaders())) {
    responseHeaders.set(k, v);
  }

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: responseHeaders,
  });
}