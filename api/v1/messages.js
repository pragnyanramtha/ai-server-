const DEFAULT_MODEL = "z-ai/glm-5.1";
const DEFAULT_UPSTREAM = "https://ai.hackclub.com/proxy/v1/chat/completions";

export const config = {
  runtime: "edge",
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-api-key, anthropic-version",
  };
}

function toOpenAIContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part?.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function anthropicToOpenAI(body) {
  const messages = [];

  if (body?.system) {
    messages.push({
      role: "system",
      content: toOpenAIContent(body.system),
    });
  }

  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) {
      if (!message?.role) continue;
      messages.push({
        role: message.role,
        content: toOpenAIContent(message.content),
      });
    }
  }

  return {
    model: body?.model || DEFAULT_MODEL,
    messages,
    max_tokens: body?.max_tokens,
    temperature: body?.temperature,
    top_p: body?.top_p,
    stop: body?.stop_sequences,
    stream: Boolean(body?.stream),
  };
}

function toAnthropicContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" && typeof part?.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function finishReasonToStopReason(reason) {
  if (reason === "stop") return "end_turn";
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls") return "tool_use";
  return "end_turn";
}

function openAIToAnthropic(body, requestedModel) {
  const firstChoice = body?.choices?.[0];
  const text = toAnthropicContent(firstChoice?.message?.content);

  return {
    id: body?.id || `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: body?.model || requestedModel || DEFAULT_MODEL,
    content: [{ type: "text", text }],
    stop_reason: finishReasonToStopReason(firstChoice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: body?.usage?.prompt_tokens ?? 0,
      output_tokens: body?.usage?.completion_tokens ?? 0,
    },
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

  const payload = anthropicToOpenAI(body);
  const upstreamUrl = process.env.HACKCLUB_BASE_URL || DEFAULT_UPSTREAM;
  const upstreamRes = await fetch(upstreamUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!upstreamRes.ok) {
    const responseHeaders = new Headers(upstreamRes.headers);
    for (const [k, v] of Object.entries(corsHeaders())) {
      responseHeaders.set(k, v);
    }

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: responseHeaders,
    });
  }

  let upstreamBody;
  try {
    upstreamBody = await upstreamRes.json();
  } catch {
    return new Response(JSON.stringify({ error: "Upstream returned invalid JSON" }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  return new Response(JSON.stringify(openAIToAnthropic(upstreamBody, body?.model)), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}
