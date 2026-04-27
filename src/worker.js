const DEFAULT_MODEL = "z-ai/glm-5.1";
const DEFAULT_UPSTREAM = "https://ai.hackclub.com/proxy/v1/chat/completions";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-api-key, anthropic-version",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
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

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const isOpenAIEndpoint = pathname === "/v1/chat/completions";
    const isAnthropicEndpoint = pathname === "/v1/messages";

    if (!isOpenAIEndpoint && !isAnthropicEndpoint) {
      return jsonResponse({ error: "Not found" }, 404);
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    if (!env.HACK_CLUB_AI_API_KEY) {
      return jsonResponse({ error: "Server misconfigured" }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const payload = isAnthropicEndpoint
      ? anthropicToOpenAI(body)
      : {
          ...body,
          model: body?.model || DEFAULT_MODEL,
        };

    const upstreamUrl = env.HACKCLUB_BASE_URL || DEFAULT_UPSTREAM;
    const upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.HACK_CLUB_AI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (isAnthropicEndpoint && upstreamRes.ok) {
      let upstreamBody;
      try {
        upstreamBody = await upstreamRes.json();
      } catch {
        return jsonResponse({ error: "Upstream returned invalid JSON" }, 502);
      }
      return jsonResponse(openAIToAnthropic(upstreamBody, body?.model), 200);
    }

    const responseHeaders = new Headers(upstreamRes.headers);
    for (const [k, v] of Object.entries(corsHeaders())) {
      responseHeaders.set(k, v);
    }

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: responseHeaders,
    });
  },
};
