/**
 * Request-scoped tenant ownership.
 *
 * Protocol adapters re-enter `/v1/chat/completions` over loopback with the
 * operator credential, which would otherwise make every adapter request look
 * like the same (admin) tenant. They forward the caller's session scope with a
 * per-process secret so the inner chat route can keep per-user thread state
 * isolated without trusting a client-supplied header.
 */

import crypto from "node:crypto";
import type { Context } from "hono";
import { constantTimeStringEqual } from "./auth-identity.ts";
import { getUserIdentity } from "./request-user.ts";

export const INTERNAL_SESSION_SCOPE_HEADER = "x-qwenproxy-session-scope";
export const INTERNAL_SESSION_SCOPE_TOKEN_HEADER =
  "x-qwenproxy-session-scope-token";

/**
 * Random per-process capability. Loopback adapter calls include it so the chat
 * route knows the scope header was produced by this proxy, not by a caller
 * trying to reach another tenant's thread.
 */
const INTERNAL_SESSION_SCOPE_TOKEN = crypto.randomUUID();

/**
 * Scope used to namespace logical thread state.
 *
 * Operators (admin role / legacy local or global key) intentionally share the
 * historical unscoped namespace so existing deployments keep their threads.
 * Regular users get their identity id mixed into the derived session id, which
 * prevents session-id hijacking and implicit-thread collisions between tenants.
 */
export function getSessionScopeId(c: Context): string | undefined {
  const identity = getUserIdentity(c);
  if (!identity || identity.role === "admin") return undefined;
  return identity.id;
}

/** Headers an adapter must add when dispatching to the loopback chat route. */
export function buildInternalSessionScopeHeaders(
  c: Context,
): Record<string, string> {
  const scope = getSessionScopeId(c);
  if (!scope) return {};
  return {
    [INTERNAL_SESSION_SCOPE_HEADER]: scope,
    [INTERNAL_SESSION_SCOPE_TOKEN_HEADER]: INTERNAL_SESSION_SCOPE_TOKEN,
  };
}

/** Resolve the effective session scope, honouring trusted adapter forwarding. */
export function resolveSessionScopeId(c: Context): string | undefined {
  const token = c.req.header(INTERNAL_SESSION_SCOPE_TOKEN_HEADER);
  const scope = c.req.header(INTERNAL_SESSION_SCOPE_HEADER);
  if (
    token &&
    scope &&
    constantTimeStringEqual(token, INTERNAL_SESSION_SCOPE_TOKEN)
  ) {
    return scope;
  }
  return getSessionScopeId(c);
}
