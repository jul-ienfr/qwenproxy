import crypto from "crypto";
import { Hono, type Context } from "hono";
import { stream as honoStream } from "hono/streaming";
import { config } from "../../core/config.ts";
import { getInternalOrigin } from "../../core/internal-origin.ts";
import { getUserIdentity } from "../../core/request-user.ts";
import { buildInternalSessionScopeHeaders } from "../../core/request-owner.ts";
import { validateAnthropicRequest } from "./validation.ts";
import {
  translateAnthropicToOpenAI,
  translateOpenAIToAnthropic,
  translateStreamChunk,
  generateMessageId,
  type AnthropicStreamState,
} from "./translate.ts";
import type { AnthropicRequest, OpenAIResponse } from "./types.ts";
import { estimateTokenCount } from "../../utils/context-truncation.ts";
import { extractSseError, statusForSseError } from "../../utils/sse-error.ts";
import { resolveQwenProxyError } from "../../api/error-helpers.ts";

const app = new Hono();

/**
 * Anthropic's public error types keyed by HTTP status. Mirrors the global
 * handler in server.ts so route-level catches render the same envelope as the
 * framework-level safety net.
 */
function anthropicTypeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 413:
      return "request_too_large";
    case 429:
      return "rate_limit_error";
    case 529:
      return "overloaded_error";
    default:
      return "api_error";
  }
}

function generateRequestId(): string {
  return `req_${crypto.randomBytes(12).toString("hex")}`;
}

export function anthropicError(
  c: Context,
  type: string,
  message: string,
  statusCode: number,
) {
  c.header("anthropic-version", c.req.header("anthropic-version") || "2023-06-01");
  return c.json(
    {
      type: "error",
      error: { type, message },
      request_id: generateRequestId(),
    },
    statusCode as any,
  );
}

/**
 * Authentication is resolved once by the /v1 middleware in server.ts, which
 * accepts the legacy API_KEY plus per-user database keys. This route-level
 * helper only asserts that an identity was attached.
 */
export function verifyAnthropicApiKey(c: Context): boolean {
  return Boolean(getUserIdentity(c));
}

/**
 * POST /v1/messages - Anthropic Messages API compatible endpoint.
 */
app.post("/v1/messages", async (c) => {
  const requestId = generateRequestId();
  const anthropicVersion = c.req.header("anthropic-version") || "2023-06-01";

  // 1. Verify API key
  if (!verifyAnthropicApiKey(c)) {
    return anthropicError(c, "authentication_error", "Invalid API key", 401);
  }

  // 2. Parse & Validate body
  let body: AnthropicRequest;
  try {
    body = await c.req.json();
  } catch {
    return anthropicError(c, "invalid_request_error", "Invalid JSON body", 400);
  }

  const validation = validateAnthropicRequest(body);
  if (!validation.valid) {
    return anthropicError(c, "invalid_request_error", validation.error!, 400);
  }

  const isStream = body.stream ?? false;
  const requestModel = body.model;


  try {
    // 3. Translate Anthropic request to internal OpenAI format
    const openaiRequest = translateAnthropicToOpenAI(body);
    const claudeSessionId =
      c.req.header("x-claude-code-session-id") ||
      (typeof body.metadata?.user_id === "string" && body.metadata.user_id.includes('"session_id":')
        ? (() => {
            try {
              const parsed = JSON.parse(body.metadata.user_id as string);
              return typeof parsed?.session_id === "string" ? parsed.session_id : undefined;
            } catch {
              return undefined;
            }
          })()
        : undefined);

    const dispatchToChat = (streamMode: boolean) =>
      fetch(`${getInternalOrigin()}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.API_KEY || config.apiKey || ""}`,
          "x-qwenproxy-route": "Anthropic",
          ...buildInternalSessionScopeHeaders(c),
          ...(c.req.header("x-qwenproxy-chat-mode")
            ? { "x-qwenproxy-chat-mode": c.req.header("x-qwenproxy-chat-mode")! }
            : {}),
          ...(claudeSessionId ? { "x-session-id": claudeSessionId } : {}),
        },
        body: JSON.stringify({
          ...openaiRequest,
          ...(claudeSessionId ? { session_id: claudeSessionId } : {}),
          stream: streamMode,
          ...(streamMode ? { stream_options: { include_usage: true } } : {}),
        }),
        signal: c.req.raw.signal,
      });

    if (isStream) {
      // ============ STREAMING MODE ============
      const socket =
        (c.env as any)?.incoming?.socket || (c.req.raw as any)?.socket;
      if (socket && typeof socket.setNoDelay === "function") {
        socket.setNoDelay(true);
      }

      c.header("Content-Type", "text/event-stream; charset=utf-8");
      c.header("Cache-Control", "no-cache, no-transform");
      c.header("Connection", "keep-alive");
      c.header("X-Accel-Buffering", "no");
      c.header("anthropic-version", anthropicVersion);
      c.header("request-id", requestId);
      return honoStream(c, async (stream) => {
        const encoder = new TextEncoder();
        const write = async (data: string) => {
          await stream.write(encoder.encode(data));
        };

        const messageId = generateMessageId();
        const state: AnthropicStreamState = {
          contentBlockIndex: 0,
          currentBlockType: null,
          currentToolId: null,
          currentToolIndex: null,
          requestModel,
          inputTokens: 0,
          outputTokens: 0,
          hasEmittedToolUse: false,
        };

        // Emit initial message_start event
        const messageStart = {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            content: [],
            model: requestModel,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 1 },
          },
        };
        await write(
          `event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`,
        );

        // Keep-alive heartbeat
        const heartbeatInterval = setInterval(() => {
          write(": keep-alive\n\n").catch(() => clearInterval(heartbeatInterval));
        }, 15000);

        try {
          const response = await dispatchToChat(true);

          if (!response.ok) {
            clearInterval(heartbeatInterval);
            const errText = await response.text().catch(() => "");
            console.error(`[Anthropic] Upstream error: ${response.status} ${errText}`);
            const errorJson = (() => {
              try {
                return JSON.parse(errText);
              } catch {
                return null;
              }
            })();
            const message =
              errorJson?.error?.message ||
              errorJson?.message ||
              `Upstream error: ${response.status}`;
            const errorType = anthropicTypeForStatus(response.status);
            await write(
              `event: error\ndata: ${JSON.stringify({
                type: "error",
                error: { type: errorType, message },
              })}\n\n`,
            );
            return;
          }

          const reader = response.body?.getReader();
          if (!reader) {
            throw new Error("No response body from internal chat stream");
          }

          const decoder = new TextDecoder();
          let buffer = "";

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data: ")) continue;
                const dataStr = trimmed.slice(6);
                if (dataStr === "[DONE]") continue;

                let chunk: any;
                try {
                  chunk = JSON.parse(dataStr);
                } catch {
                  // Skip invalid JSON lines
                  continue;
                }

                // The inner chat stream reports post-commit failures as a
                // terminal error frame. Surface it instead of emitting a
                // successful message_stop for a failed generation.
                const streamError = extractSseError(chunk);
                if (streamError) {
                  const failure = new Error(streamError.message) as Error & {
                    statusCode?: number;
                    code?: string;
                  };
                  failure.statusCode = statusForSseError(streamError);
                  failure.code = streamError.code;
                  throw failure;
                }

                try {
                  const events = translateStreamChunk(chunk, state);
                  for (const event of events) {
                    const parsed = JSON.parse(event);
                    await write(`event: ${parsed.type}\ndata: ${event}\n\n`);
                  }
                } catch {
                  // Skip malformed translation output for this chunk
                }
              }
            }
          } finally {
            reader.releaseLock();
          }

          // Close any remaining open content block before ending message
          if (state.currentBlockType !== null) {
            await write(
              `event: content_block_stop\ndata: ${JSON.stringify({
                type: "content_block_stop",
                index: state.contentBlockIndex,
              })}\n\n`,
            );
            state.contentBlockIndex++;
            state.currentBlockType = null;
          }

          // Emit final message_stop
          await write(
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
          );
        } catch (error: any) {
          const isClientAbort =
            c.req.raw.signal.aborted ||
            error?.name === "AbortError" ||
            error?.code === "ECONNRESET" ||
            (typeof error?.message === "string" &&
              (error.message.includes("prematurely closed") ||
                error.message.includes("aborted") ||
                error.message.includes("canceled") ||
                error.message.includes("cancelled")));
          if (!isClientAbort) {
            console.error("❌ [Anthropic] Stream error:", error?.message || error);
          }
          const statusCode = resolveQwenProxyError(error, 500).statusCode;
          const errorType = anthropicTypeForStatus(statusCode);
          try {
            await write(
              `event: error\ndata: ${JSON.stringify({
                type: "error",
                error: { type: errorType, message: error?.message || "Stream error" },
              })}\n\n`,
            );
          } catch {
            // Client closed connection
          }
        } finally {
          clearInterval(heartbeatInterval);
        }
      });
    } else {
      // ============ NON-STREAMING MODE ============
      const response = await dispatchToChat(false);

      if (!response.ok) {
        const errorJson = await response.json().catch(() => null);
        const errorText = errorJson?.error?.message || `HTTP ${response.status}`;
        console.error(`[Anthropic] Upstream error: ${response.status} ${errorText}`);

        return anthropicError(
          c,
          anthropicTypeForStatus(response.status),
          errorText,
          response.status,
        );
      }

      const openaiResponse: OpenAIResponse = await response.json();
      const anthropicResponse = translateOpenAIToAnthropic(
        openaiResponse,
        requestModel,
      );


      c.header("anthropic-version", anthropicVersion);
      c.header("request-id", requestId);

      return c.json(anthropicResponse);
    }
  } catch (error: any) {
    // Client closed the request mid-flight: silent, mirrors the 499 handling
    // of the chat/completions routes instead of reporting a server failure.
    if (c.req.raw.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    console.error("❌ [Anthropic] Error:", error);
    const resolved = resolveQwenProxyError(error, 500);
    return anthropicError(
      c,
      anthropicTypeForStatus(resolved.statusCode),
      resolved.message || "Internal server error",
      resolved.statusCode,
    );
  }
});

/**
 * POST /v1/messages/count_tokens - Anthropic Token Counting API.
 */
app.post("/v1/messages/count_tokens", async (c) => {
  if (!verifyAnthropicApiKey(c)) {
    return anthropicError(c, "authentication_error", "Invalid API key", 401);
  }

  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return anthropicError(c, "invalid_request_error", "Request body must be a JSON object", 400);
    }

    let textToCount = "";
    if (typeof body.system === "string") {
      textToCount += body.system + " ";
    } else if (Array.isArray(body.system)) {
      textToCount += body.system.map((s: any) => s?.text || "").join(" ") + " ";
    }

    if (Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (!m || typeof m !== "object") continue;
        if (typeof m.content === "string") {
          textToCount += m.content + " ";
        } else if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b?.text) textToCount += b.text + " ";
            if (b?.content) textToCount += (typeof b.content === "string" ? b.content : JSON.stringify(b.content)) + " ";
          }
        }
      }
    }

    if (Array.isArray(body.tools)) {
      textToCount += JSON.stringify(body.tools);
    }

    const inputTokens = Math.max(1, estimateTokenCount(textToCount));

    c.header("anthropic-version", c.req.header("anthropic-version") || "2023-06-01");
    return c.json({
      input_tokens: inputTokens,
    });
  } catch {
    return anthropicError(c, "invalid_request_error", "Invalid request body", 400);
  }
});

export { app as anthropicApp };
