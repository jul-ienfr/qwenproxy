import { Hono, type Context } from "hono";
import { stream as honoStream } from "hono/streaming";
import { config } from "../../core/config.ts";
import { getUserIdentity } from "../../core/request-user.ts";
import { logger } from "../../core/logger.js";
import { loadModelsWithVariants } from "../../api/models.ts";
import {
  getModelCapabilities,
  getModelContextWindow,
} from "../../core/model-registry.ts";
import { validateGeminiRequest } from "./validation.ts";
import {
  createGeminiStreamState,
  finalizeGeminiStream,
  isSupportedGeminiModel,
  mapGeminiModel,
  translateGeminiToOpenAI,
  translateOpenAIToGemini,
  translateStreamChunk,
} from "./translate.ts";
import type {
  ChatRequest,
  GeminiRequest,
  GeminiResponse,
  TranslationWarning,
} from "./types.ts";

const app = new Hono();

const MODELS_PREFIX = "/v1beta/models/";

const GEMINI_STATUS_BY_CODE: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  405: "UNIMPLEMENTED",
  409: "ABORTED",
  429: "RESOURCE_EXHAUSTED",
  499: "CANCELLED",
  500: "INTERNAL",
  501: "UNIMPLEMENTED",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
};

export function geminiStatusForCode(code: number): string {
  return GEMINI_STATUS_BY_CODE[code] || (code >= 500 ? "INTERNAL" : "UNKNOWN");
}

export function geminiError(
  c: Context,
  code: number,
  message: string,
  details?: unknown[],
) {
  return c.json(
    {
      error: {
        code,
        message,
        status: geminiStatusForCode(code),
        ...(details ? { details } : {}),
      },
    },
    code as any,
  );
}

function verifyGeminiApiKey(c: Context): boolean {
  return Boolean(getUserIdentity(c));
}

function parseModelAction(
  path: string,
): { model: string; action: string } | null {
  if (!path.startsWith(MODELS_PREFIX)) return null;
  const rest = path.slice(MODELS_PREFIX.length);
  const separator = rest.lastIndexOf(":");
  if (separator <= 0) return null;

  const rawModel = rest.slice(0, separator);
  const action = rest.slice(separator + 1);
  if (!rawModel || !action) return null;

  try {
    return { model: decodeURIComponent(rawModel), action };
  } catch {
    return { model: rawModel, action };
  }
}

/**
 * Expose translation warnings through a response header so unsupported Gemini
 * fields are observable instead of silently dropped. The value is forced to
 * printable ASCII because HTTP headers are latin-1 and model ids may not be.
 */
function warningsHeader(warnings: TranslationWarning[]): string | undefined {
  if (warnings.length === 0) return undefined;
  const text = warnings
    .map((warning) => `${warning.field}=${warning.action}`)
    .join("; ");
  const ascii = text.replace(/[^\x20-\x7e]/g, "?");
  return ascii.length > 1800 ? `${ascii.slice(0, 1797)}...` : ascii;
}

function normalizeModelName(model: string): string {
  return model.trim().replace(/^models\//, "");
}

async function dispatchToChat(
  request: ChatRequest,
  streamMode: boolean,
  c: Context,
): Promise<Response> {
  const sessionId =
    c.req.header("x-session-id") ||
    c.req.header("x-session-affinity") ||
    undefined;

  return fetch(`http://127.0.0.1:${config.server.port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.API_KEY || config.apiKey || ""}`,
      "x-qwenproxy-route": "Gemini",
      ...(c.req.header("x-qwenproxy-chat-mode")
        ? { "x-qwenproxy-chat-mode": c.req.header("x-qwenproxy-chat-mode")! }
        : {}),
      ...(sessionId ? { "x-session-id": sessionId } : {}),
    },
    body: JSON.stringify({
      ...request,
      stream: streamMode,
      ...(streamMode ? { stream_options: { include_usage: true } } : {}),
    }),
    signal: c.req.raw.signal,
  });
}

async function upstreamErrorMessage(response: Response): Promise<string> {
  const errorJson = await response.json().catch(() => null);
  return (
    errorJson?.error?.message ||
    errorJson?.message ||
    `Upstream error: HTTP ${response.status}`
  );
}

function isClientAbort(c: Context, error: unknown): boolean {
  const err = error as any;
  return (
    c.req.raw.signal.aborted ||
    err?.name === "AbortError" ||
    err?.code === "ECONNRESET" ||
    (typeof err?.message === "string" &&
      (err.message.includes("prematurely closed") ||
        err.message.includes("aborted") ||
        err.message.includes("canceled") ||
        err.message.includes("cancelled")))
  );
}

/**
 * POST /v1beta/models/{model}:generateContent
 * POST /v1beta/models/{model}:streamGenerateContent
 */
app.post("/v1beta/models/*", async (c) => {
  if (!verifyGeminiApiKey(c)) {
    return geminiError(c, 401, "Missing or invalid API key");
  }

  const parsed = parseModelAction(c.req.path);
  if (!parsed) {
    return geminiError(c, 404, "Model method not found");
  }

  const { model: requestModel, action } = parsed;
  const isStream = action === "streamGenerateContent";
  if (action !== "generateContent" && !isStream) {
    return geminiError(c, 404, `Unsupported method '${action}'`);
  }

  const mappedModel = mapGeminiModel(requestModel);
  if (!mappedModel || !isSupportedGeminiModel(mappedModel)) {
    return geminiError(c, 404, `Model '${requestModel}' not found`);
  }

  let body: GeminiRequest;
  try {
    body = (await c.req.json()) as GeminiRequest;
  } catch {
    return geminiError(c, 400, "Invalid JSON body");
  }

  const validation = validateGeminiRequest(body);
  if (!validation.valid) {
    return geminiError(c, 400, validation.error!);
  }

  if (
    typeof body.model === "string" &&
    body.model.trim() &&
    normalizeModelName(body.model) !== normalizeModelName(requestModel)
  ) {
    return geminiError(
      c,
      400,
      `Request model '${body.model}' does not match URL model '${requestModel}'`,
    );
  }

  const { request, warnings } = translateGeminiToOpenAI(body, requestModel);
  const warningHeader = warningsHeader(warnings);
  if (warningHeader) {
    c.header("X-QwenProxy-Gemini-Warnings", warningHeader);
  }
  if (warnings.length > 0) {
    logger.warn("[Gemini] Translation warnings", {
      requestModel,
      mappedModel,
      warnings,
    });
  }

  const maxOutputTokens = body.generationConfig?.maxOutputTokens;

  if (isStream) {
    const socket =
      (c.env as any)?.incoming?.socket || (c.req.raw as any)?.socket;
    if (socket && typeof socket.setNoDelay === "function") {
      socket.setNoDelay(true);
    }

    c.header("Content-Type", "text/event-stream; charset=utf-8");
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");

    return honoStream(c, async (stream) => {
      const encoder = new TextEncoder();
      const write = async (payload: string) => {
        await stream.write(encoder.encode(payload));
      };
      const writeChunk = async (chunk: GeminiResponse) => {
        await write(`data: ${JSON.stringify(chunk)}\n\n`);
      };

      const state = createGeminiStreamState(requestModel, maxOutputTokens);
      const heartbeat = setInterval(() => {
        write(": keep-alive\n\n").catch(() => clearInterval(heartbeat));
      }, 15000);

      try {
        const response = await dispatchToChat(request, true, c);

        if (!response.ok) {
          const message = await upstreamErrorMessage(response);
          await write(
            `data: ${JSON.stringify({
              error: {
                code: response.status,
                message,
                status: geminiStatusForCode(response.status),
              },
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

        const handleLine = async (line: string) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) return;

          const dataStr = trimmed.slice(5).trim();
          if (!dataStr || dataStr === "[DONE]") return;

          let chunk: unknown;
          try {
            chunk = JSON.parse(dataStr);
          } catch {
            return;
          }

          for (const out of translateStreamChunk(chunk as any, state)) {
            await writeChunk(out);
          }
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              await handleLine(line);
            }
          }
        } finally {
          reader.releaseLock();
        }

        if (buffer.trim()) {
          await handleLine(buffer);
        }

        // Exactly one terminal event, even when the upstream stream closed
        // without a finish_reason.
        if (!state.terminalEmitted) {
          await writeChunk(finalizeGeminiStream(state));
        }
      } catch (error) {
        if (!isClientAbort(c, error)) {
          logger.error("[Gemini] Stream error", {
            error: error instanceof Error ? error.message : String(error),
          });
          try {
            await write(
              `data: ${JSON.stringify({
                error: {
                  code: 500,
                  message:
                    error instanceof Error ? error.message : "Stream error",
                  status: "INTERNAL",
                },
              })}\n\n`,
            );
          } catch {
            // Client closed the connection; nothing left to write to.
          }
        }
      } finally {
        clearInterval(heartbeat);
      }
    });
  }

  try {
    const response = await dispatchToChat(request, false, c);

    if (!response.ok) {
      const message = await upstreamErrorMessage(response);
      return geminiError(c, response.status, message);
    }

    const openaiResponse = await response.json();
    const geminiResponse = translateOpenAIToGemini(
      openaiResponse,
      requestModel,
      { maxOutputTokens },
    );

    return c.json(geminiResponse);
  } catch (error) {
    if (isClientAbort(c, error)) {
      return geminiError(c, 499, "Request cancelled");
    }
    logger.error("[Gemini] Request error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return geminiError(
      c,
      500,
      error instanceof Error ? error.message : "Internal server error",
    );
  }
});

function toGeminiModel(model: any, accountId?: string) {
  const capabilities = getModelCapabilities(model.id, accountId);
  const inputTokenLimit =
    typeof model.context_window === "number"
      ? model.context_window
      : getModelContextWindow(model.id, accountId);

  return {
    name: `models/${model.id}`,
    displayName:
      typeof model.name === "string" && model.name ? model.name : model.id,
    description: `Qwen model ${model.id}`,
    inputTokenLimit,
    outputTokenLimit: capabilities.maxOutputTokens,
    supportedGenerationMethods: [
      "generateContent",
      "streamGenerateContent",
    ],
  };
}

/**
 * GET /v1beta/models - Gemini model discovery endpoint.
 */
app.get("/v1beta/models", async (c) => {
  if (!verifyGeminiApiKey(c)) {
    return geminiError(c, 401, "Missing or invalid API key");
  }

  try {
    const { models, accountId } = await loadModelsWithVariants();
    return c.json({
      models: models.map((model) => toGeminiModel(model, accountId)),
    });
  } catch (error) {
    logger.error("[Gemini] Models error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return geminiError(c, 500, "Failed to load models");
  }
});

/**
 * GET /v1beta/models/{model} - Gemini model metadata endpoint.
 */
app.get("/v1beta/models/:model", async (c) => {
  if (!verifyGeminiApiKey(c)) {
    return geminiError(c, 401, "Missing or invalid API key");
  }

  const modelId = normalizeModelName(c.req.param("model"));
  try {
    const { models, accountId } = await loadModelsWithVariants();
    const model = models.find((entry) => entry.id === modelId);
    if (!model) {
      return geminiError(c, 404, `Model '${modelId}' not found`);
    }
    return c.json(toGeminiModel(model, accountId));
  } catch (error) {
    logger.error("[Gemini] Model lookup error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return geminiError(c, 500, "Failed to load model");
  }
});

export { app as geminiApp };
