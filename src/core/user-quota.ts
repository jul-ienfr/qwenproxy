/**
 * Per-user request and stream quotas.
 *
 * RPM uses a 60-second sliding window; concurrency uses an active-stream
 * counter. Both are process-local. Admin and legacy identities bypass limits.
 */

import type { Context } from "hono";
import type { UserIdentity } from "./users.ts";

interface QuotaState {
  requestTimestamps: number[];
  activeStreams: number;
  requests: number;
  errors: number;
}

const states = new Map<string, QuotaState>();
const WINDOW_MS = 60_000;

function stateFor(id: string): QuotaState {
  let state = states.get(id);
  if (!state) {
    state = {
      requestTimestamps: [],
      activeStreams: 0,
      requests: 0,
      errors: 0,
    };
    states.set(id, state);
  }
  return state;
}

function bypassesQuota(identity?: UserIdentity): boolean {
  return !identity || identity.legacy || identity.role === "admin";
}

export interface QuotaDecision {
  allowed: boolean;
  retryAfterSec?: number;
  reason?: "rpm" | "concurrency";
}

/** Count one request against the user's RPM window. */
export function checkUserRequest(
  identity?: UserIdentity,
  now = Date.now(),
): QuotaDecision {
  if (bypassesQuota(identity)) return { allowed: true };
  const state = stateFor(identity!.id);
  state.requests++;
  const cutoff = now - WINDOW_MS;
  while (state.requestTimestamps.length > 0 && state.requestTimestamps[0] <= cutoff) {
    state.requestTimestamps.shift();
  }
  const limit = identity!.rateLimitRpm;
  if (limit <= 0) {
    state.requestTimestamps.push(now);
    return { allowed: true };
  }
  if (state.requestTimestamps.length >= limit) {
    const oldest = state.requestTimestamps[0] ?? now;
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)),
      reason: "rpm",
    };
  }
  state.requestTimestamps.push(now);
  return { allowed: true };
}

/**
 * Acquire one concurrent stream slot. Returns a release function, or null when
 * the user's concurrency ceiling is reached.
 */
export function acquireUserStream(identity?: UserIdentity): (() => void) | null {
  if (bypassesQuota(identity)) return () => {};
  const state = stateFor(identity!.id);
  const limit = identity!.maxConcurrency;
  if (limit > 0 && state.activeStreams >= limit) return null;
  state.activeStreams++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.activeStreams = Math.max(0, state.activeStreams - 1);
  };
}

export function recordUserError(identity?: UserIdentity): void {
  if (bypassesQuota(identity)) return;
  stateFor(identity!.id).errors++;
}

export function getUserQuotaSnapshot(id: string): {
  activeStreams: number;
  requests: number;
  errors: number;
} {
  const state = states.get(id);
  return {
    activeStreams: state?.activeStreams ?? 0,
    requests: state?.requests ?? 0,
    errors: state?.errors ?? 0,
  };
}

/** Release a stream slot when the response body closes, errors or is cancelled. */
export function withUserStreamSlot(
  response: Response,
  release: () => void,
): Response {
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          releaseOnce();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        releaseOnce();
        controller.error(error);
      }
    },
    cancel(reason) {
      releaseOnce();
      return reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** OpenAI or Anthropic shaped 429 with Retry-After. */
export function quotaErrorResponse(
  c: Context,
  retryAfterSec: number,
  reason: "rpm" | "concurrency",
): Response {
  const isAnthropic =
    c.req.path.startsWith("/v1/messages") ||
    Boolean(c.req.header("anthropic-version"));
  const message =
    reason === "rpm"
      ? `Rate limit exceeded (requests per minute). Retry in ${retryAfterSec}s.`
      : `Concurrency limit exceeded. Retry in ${retryAfterSec}s.`;
  c.header("Retry-After", String(Math.max(1, retryAfterSec)));
  if (isAnthropic) {
    c.header(
      "anthropic-version",
      c.req.header("anthropic-version") || "2023-06-01",
    );
    return c.json(
      {
        type: "error",
        error: { type: "rate_limit_error", message },
      },
      429,
    );
  }
  return c.json(
    {
      error: {
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
        message,
      },
    },
    429,
  );
}
