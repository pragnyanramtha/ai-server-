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
    model: "z-ai/glm-5.1",
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
    model: "z-ai/glm-5.1",
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
  const headers = {
    "Content-Type": "application/json",
  };

  const apiKey = process.env.HACK_CLUB_AI_API_KEY;
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const upstreamRes = await fetch(upstreamUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (body?.stream) {
    const responseHeaders = new Headers({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    for (const [k, v] of Object.entries(corsHeaders())) {
      responseHeaders.set(k, v);
    }

    const msgId = `msg_${crypto.randomUUID()}`;
    const encoder = new TextEncoder();

    let buffer = "";
    let sentStart = false;

    const transformStream = new TransformStream({
      start(controller) {
        controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            model: "z-ai/glm-5.1",
            content: [],
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          }
        })}\n\n`));

        controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" }
        })}\n\n`));
        sentStart = true;
      },
      transform(chunk, controller) {
        buffer += new TextDecoder().decode(chunk);
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (!delta?.content) continue;

            controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: delta.content }
            })}\n\n`));
          } catch {
            // Skip invalid JSON
          }
        }
      },
      flush(controller) {
        controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: 0
        })}\n\n`));

        controller.enqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 0 }
        })}\n\n`));

        controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify({
          type: "message_stop"
        })}\n\n`));
      }
    });

    return new Response(upstreamRes.body.pipeThrough(transformStream), {
      status: 200,
      headers: responseHeaders,
    });
  }

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
