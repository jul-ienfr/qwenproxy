import type { Context } from "hono";
import type { QwenProxyStatusCode } from "../core/errors.js";
import { QwenProxyError } from "../core/errors.js";
import { classifyError } from "./error-classifier.js";
import {
  applyUpstreamHint,
  errorForStatus,
  isValidStatus,
} from "./error-mapping.js";

/**
 * Sends a standardized OpenAI-compatible error response.
 * Handles QwenProxyError directly (preserving concrete upstream status/code),
 * checks upstreamStatus hints on plain errors, and falls back to the error
 * classifier.
 */
export function sendOpenAIError(
  c: Context,
  err: unknown,
  fallbackStatus?: QwenProxyStatusCode,
): Response {
  let qwenProxyErr: QwenProxyError;

  if (err instanceof QwenProxyError) {
    qwenProxyErr = applyUpstreamHint(err, { rewriteSameStatus: true });
  } else {
    const hint = (err as Record<string, unknown>)?.upstreamStatus;
    if (typeof hint === "number" && isValidStatus(hint)) {
      qwenProxyErr = errorForStatus(
        hint,
        err instanceof Error ? err.message : String(err),
      );
    } else if (fallbackStatus) {
      qwenProxyErr = errorForStatus(
        fallbackStatus,
        err instanceof Error ? err.message : String(err),
      );
    } else {
      qwenProxyErr = classifyError(err);
    }
  }

  const inner = qwenProxyErr.toOpenAI().error;
  const body = {
    error: {
      message: inner.message,
      type: inner.type,
      code: inner.code,
      param: inner.param ?? null,
    },
  };
  // 499 (Client Closed Request) is not part of Hono's ContentfulStatusCode
  // union. The abort is intercepted before sendOpenAIError in the chat route,
  // but keep the fallback type-safe by building the Response directly.
  if (qwenProxyErr.statusCode === 499) {
    return new Response(JSON.stringify(body), {
      status: 499,
      headers: { "content-type": "application/json" },
    });
  }
  return c.json(body, qwenProxyErr.statusCode);
}

/**
 * Creates a QwenProxyError mapped to the given HTTP status code.
 * Useful for inline error returns without throwing.
 */
export function createError(
  status: QwenProxyStatusCode,
  message: string,
  param?: string,
): QwenProxyError {
  const err = errorForStatus(status, message);
  if (param) err.param = param;
  return err;
}
