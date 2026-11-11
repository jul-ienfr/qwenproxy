/**
 * Dashboard authentication.
 *
 * API clients keep using Authorization/x-api-key. Browsers use the signed
 * session cookie created by /admin/api/session. Cookie-authenticated mutations
 * additionally require the session's CSRF token.
 */

import type { Context } from "hono";
import { config } from "../core/config.ts";
import { getRuntimeApiKey, isPlaceholderApiKey } from "../core/local-auth.ts";
import {
  extractProvidedApiKeys,
  GLOBAL_ADMIN_IDENTITY,
  identityErrorMessage,
  LOCAL_ADMIN_IDENTITY,
  resolveIdentity,
} from "../core/auth-identity.ts";
import {
  identityFromSession,
  readSessionCookie,
  validateCsrf,
  verifyAdminSession,
  type AdminSessionPayload,
} from "../core/admin-session.ts";
import {
  getUserApiKeyHash,
  getUserById,
  hashApiKey,
  type UserIdentity,
} from "../core/users.ts";

const LEGACY_SESSION_SUBJECTS = new Set([
  LOCAL_ADMIN_IDENTITY.id,
  GLOBAL_ADMIN_IDENTITY.id,
]);

function currentGlobalKeyHash(): string | null {
  const key = (getRuntimeApiKey() || config.apiKey || "").trim();
  if (!key || isPlaceholderApiKey(key)) return null;
  return hashApiKey(key);
}

/**
 * Digest to bind a dashboard session to the credential that created it.
 * Loopback logins have no configured key, so they stay unbound and are
 * revalidated as a legacy operator identity.
 */
export function sessionCredentialHash(
  identity: UserIdentity,
  providedKey: string,
): string | undefined {
  if (!providedKey || identity.id === LOCAL_ADMIN_IDENTITY.id) return undefined;
  return hashApiKey(providedKey);
}

export interface AdminAuthSuccess {
  identity: UserIdentity;
  via: "key" | "session";
  session?: AdminSessionPayload;
}

export interface AdminAuthFailure {
  response: Response;
}

export type AdminAuthResult = AdminAuthSuccess | AdminAuthFailure;

export function adminJsonError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 429 | 500 | 502,
  message: string,
  type?: string,
): Response {
  const errorType =
    type ??
    (status === 401
      ? "authentication_error"
      : status === 403
        ? "permission_error"
        : status === 404
          ? "not_found_error"
          : status >= 500
            ? "server_error"
            : "invalid_request_error");
  return c.json({ error: { type: errorType, message } }, status);
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Revalidate a signed dashboard session against its backing identity.
 *
 * Legacy operator identities (global API key / loopback) have no database row.
 * Per-user sessions must still map to an active admin user: revoking or
 * demoting a user immediately invalidates cookies minted before the change
 * instead of leaving dashboard access valid until the 8h TTL expires.
 */
export function revalidateAdminSession(
  session: AdminSessionPayload,
): UserIdentity | null {
  if (LEGACY_SESSION_SUBJECTS.has(session.sub)) {
    if (session.keyHash) {
      const current = currentGlobalKeyHash();
      if (!current || current !== session.keyHash) return null;
    }
    return identityFromSession(session);
  }

  const user = getUserById(session.sub);
  if (!user || user.revoked_at || user.role !== "admin") return null;
  // Bound sessions die when the API key is rotated. Sessions minted before
  // this binding existed have no hash and require a fresh login.
  const currentKeyHash = getUserApiKeyHash(session.sub);
  if (!session.keyHash || !currentKeyHash || session.keyHash !== currentKeyHash) {
    return null;
  }

  return {
    id: user.id,
    label: user.label,
    role: user.role,
    rateLimitRpm: 0,
    maxConcurrency: 0,
    legacy: false,
  };
}

/**
 * Reject a browser cross-origin dashboard mutation. Compare hosts rather than
 * full origins: a TLS-terminating reverse proxy makes the browser send https://
 * while Node sees http://. The Host header (and therefore the request URL) must
 * still match exactly. No Origin header means a non-browser client, which is
 * allowed (CSRF only exists for ambient cookie/legacy credentials).
 */
function rejectCrossOriginMutation(c: Context): Response | null {
  if (!MUTATING_METHODS.has(c.req.method.toUpperCase())) return null;
  const origin = c.req.header("origin");
  if (!origin) return null;

  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = null;
  }
  let expectedHost: string | null = null;
  try {
    expectedHost = new URL(c.req.url).host;
  } catch {
    expectedHost = c.req.header("host")?.trim() || null;
  }
  if (
    !originHost ||
    !expectedHost ||
    originHost.toLowerCase() !== expectedHost.toLowerCase()
  ) {
    return adminJsonError(c, 403, "Cross-origin dashboard mutation rejected");
  }
  return null;
}

export function authenticateAdminRequest(c: Context): AdminAuthResult {
  const candidates = extractProvidedApiKeys({
    authorization: c.req.header("authorization"),
    apiKey: c.req.header("x-api-key"),
  });

  if (candidates.length > 0) {
    const resolution = resolveIdentity(candidates);
    if (resolution.error || !resolution.identity) {
      return {
        response: adminJsonError(
          c,
          401,
          identityErrorMessage(resolution.error ?? "invalid"),
        ),
      };
    }
    return { identity: resolution.identity, via: "key" };
  }

  const session = verifyAdminSession(
    readSessionCookie(c.req.header("cookie")),
  );
  if (!session) {
    // Preserve the historical no-key loopback behavior for the admin surface.
    // resolveIdentity([]) only grants this when no API_KEY is configured and no
    // proxy-minted key was supplied.
    const local = resolveIdentity([]);
    if (local.identity) {
      // The legacy no-key identity has no CSRF token to verify, so still reject
      // browser cross-origin mutations; otherwise any web page could drive the
      // operator's dashboard through the browser.
      const crossOrigin = rejectCrossOriginMutation(c);
      if (crossOrigin) return { response: crossOrigin };
      return { identity: local.identity, via: "key" };
    }
    return { response: adminJsonError(c, 401, "Admin session required") };
  }

  const identity = revalidateAdminSession(session);
  if (!identity) {
    return {
      response: adminJsonError(
        c,
        401,
        "Admin session no longer valid; sign in again",
      ),
    };
  }

  const crossOrigin = rejectCrossOriginMutation(c);
  if (crossOrigin) return { response: crossOrigin };
  if (
    MUTATING_METHODS.has(c.req.method.toUpperCase()) &&
    !validateCsrf(session, c.req.header("x-csrf-token"))
  ) {
    return { response: adminJsonError(c, 403, "Invalid CSRF token") };
  }

  return {
    identity,
    via: "session",
    session,
  };
}
