/**
 * Legacy OpenAI Completions API (POST /v1/completions) — thin adapter over the
 * internal Chat Completions pipeline. The legacy surface uses a freeform
 * `prompt` (string | array) instead of messages, and returns
 * `{"object":"text_completion","choices":[{"text":...}]}` with `cmpl-` ids.
 *
 * The internal dispatch follows the same self-fetch pattern as the Responses
 * API: the request is adapted to a chat body and re-entered through
 * /v1/chat/completions so all the battle-tested machinery (threads, tool
 * parsing, failover, usage accounting) applies unchanged.
 */

import { Hono, type Context } from "hono";
import { config } from "../core/config.ts";
import { getInternalOrigin } from "../core/internal-origin.ts";
import { buildInternalSessionScopeHeaders } from "../core/request-owner.ts";
import { extractSseError, statusForSseError } from "../utils/sse-error.ts";

const app = new Hono();

function makeCompletionId(): string {
  return `cmpl-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

interface CompletionsBody {
  model?: unknown;
  prompt?: unknown;
  stream?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  stop?: unknown;
  presence_penalty?: unknown;
  frequency_penalty?: unknown;
}

async function completionsUpstreamError(c: Context, response: Response) {
  // Propagate the inner chat error instead of flattening every failure to 502:
  // clients need 429 to back off and 400 to fix their request.
  const errorJson = await response.json().catch(() => null);
  const message =
    errorJson?.error?.message || `Upstream service error: ${response.status}`;
  const type =
    response.status === 429
      ? "rate_limit_error"
      : response.status === 404
        ? "not_found_error"
        : response.status === 400
          ? "invalid_request_error"
          : "api_error";
  return completionsError(c, type, message, response.status);
}

function completionsError(
  c: Context,
  type: string,
  message: string,
  statusCode: number,
) {
  return c.json(
    {
      error: {
        message,
        type,
        param: null,
        code: type === "invalid_request_error" ? "invalid_request" : type,
      },
    },
    statusCode as any,
  );
}

export async function completionsLegacy(c: Context) {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return completionsError(c, "invalid_request_error", "Invalid JSON body", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return completionsError(
      c,
      "invalid_request_error",
      "Request body must be a JSON object",
      400,
    );
  }
  const body = parsed as CompletionsBody;

  if (typeof body.model !== "string" || body.model.trim().length === 0) {
    return completionsError(
      c,
      "invalid_request_error",
      "The 'model' parameter is required",
      400,
    );
  }
  if (body.prompt === undefined || body.prompt === null) {
    return completionsError(
      c,
      "invalid_request_error",
      "The 'prompt' parameter is required",
      400,
    );
  }
  if (
    typeof body.prompt !== "string" &&
    (!Array.isArray(body.prompt) ||
      !body.prompt.every(
        (part) =>
          typeof part === "string" ||
          (typeof part === "number" && Number.isFinite(part)),
      ))
  ) {
    return completionsError(
      c,
      "invalid_request_error",
      "The 'prompt' parameter must be a string or an array of strings",
      400,
    );
  }

  if (
    body.stream !== undefined &&
    typeof body.stream !== "boolean"
  ) {
    return completionsError(
      c,
      "invalid_request_error",
      "The 'stream' parameter must be a boolean",
      400,
    );
  }
  const prompt = body.prompt as string | Array<string | number>;
  const promptText = Array.isArray(prompt)
    ? prompt.map((part) => String(part)).join("\n")
    : prompt;
  if (promptText.trim().length === 0) {
    return completionsError(
      c,
      "invalid_request_error",
      "The 'prompt' parameter must not be empty",
      400,
    );
  }
  const isStream = body.stream === true;

  const chatBody: Record<string, unknown> = {
    model: body.model,
    messages: [{ role: "user", content: promptText }],
    stream: isStream,
  };
  for (const key of [
    "max_tokens",
    "temperature",
    "top_p",
    "stop",
    "presence_penalty",
    "frequency_penalty",
  ] as const) {
    if (body[key] !== undefined) chatBody[key] = body[key];
  }

  const dispatchToChat = () =>
    fetch(`${getInternalOrigin()}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.API_KEY || config.apiKey || ""}`,
        "x-qwenproxy-route": "Completions",
        ...buildInternalSessionScopeHeaders(c),
      },
      body: JSON.stringify(chatBody),
      signal: c.req.raw.signal,
    });

  try {
    if (isStream) {
      // ============ STREAMING MODE ============
      const socket =
        (c.env as any)?.incoming?.socket || (c.req.raw as any)?.socket;
      if (socket && typeof socket.setNoDelay === "function") {
        socket.setNoDelay(true);
      }

      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache, no-transform");
      c.header("Connection", "keep-alive");
      c.header("X-Accel-Buffering", "no");
      const completionId = makeCompletionId();
      const created = Math.floor(Date.now() / 1000);
      const model = body.model;

      const response = await dispatchToChat();
      if (!response.ok) {
        return completionsUpstreamError(c, response);
      }
      const reader = response.body?.getReader();
      if (!reader) {
        return completionsError(c, "api_error", "No response body", 502);
      }

      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const stream = new ReadableStream({
        async start(controller) {
          let buffer = "";
          let closed = false;
          const enqueue = (data: unknown) => {
            if (closed) return;
            try {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
              );
            } catch {
              closed = true;
            }
          };

          try {
            readLoop: while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;
                const dataStr = trimmed.slice(5).trim();
                if (!dataStr || dataStr === "[DONE]") continue;

                let chunk: any;
                try {
                  chunk = JSON.parse(dataStr);
                } catch {
                  continue;
                }

                // Surface a post-commit upstream failure instead of ending the
                // legacy stream as if generation had completed normally.
                const streamError = extractSseError(chunk);
                if (streamError) {
                  enqueue({
                    error: {
                      message: streamError.message,
                      type: streamError.type ?? "upstream_error",
                      code: streamError.code,
                      param: null,
                      status: statusForSseError(streamError),
                    },
                  });
                  break readLoop;
                }

                const choice = chunk.choices?.[0];
                const delta = choice?.delta || {};
                if (delta.content) {
                  enqueue({
                    id: completionId,
                    object: "text_completion",
                    created,
                    model,
                    choices: [
                      {
                        text: delta.content,
                        index: 0,
                        logprobs: null,
                        finish_reason: null,
                      },
                    ],
                  });
                } else if (choice?.finish_reason) {
                  enqueue({
                    id: completionId,
                    object: "text_completion",
                    created,
                    model,
                    choices: [
                      {
                        text: "",
                        index: 0,
                        logprobs: null,
                        finish_reason: choice.finish_reason,
                      },
                    ],
                  });
                } else if (
                  Array.isArray(chunk.choices) &&
                  chunk.choices.length === 0 &&
                  chunk.usage
                ) {
                  enqueue({
                    id: completionId,
                    object: "text_completion",
                    created,
                    model,
                    choices: [],
                    usage: chunk.usage,
                  });
                }
              }
            }

            if (!closed) {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            }
          } catch {
            // Client disconnect — the stream is gone; nothing else to emit.
          } finally {
            reader.releaseLock();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "Transfer-Encoding": "chunked",
        },
      });
    }

    // ============ NON-STREAMING MODE ============
    const response = await dispatchToChat();
    if (!response.ok) {
      return completionsUpstreamError(c, response);
    }
    const chatRes: any = await response.json();
    const choice = chatRes.choices?.[0];

    return c.json({
      id: makeCompletionId(),
      object: "text_completion",
      created: chatRes.created ?? Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [
        {
          text: choice?.message?.content ?? "",
          index: 0,
          logprobs: null,
          finish_reason: choice?.finish_reason ?? "stop",
        },
      ],
      usage: chatRes.usage ?? null,
    });
  } catch (error) {
    // Client closed the request mid-flight: silent, mirrors the 499 handling
    // of the chat route. Anything else is a server-side failure.
    if (c.req.raw.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    return completionsError(c, "api_error", "Internal server error", 500);
  }
}

export { app as completionsApp };
