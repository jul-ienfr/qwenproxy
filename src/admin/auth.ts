/**
 * Dashboard authentication.
 *
 * API clients keep using Authorization/x-api-key. Browsers use the signed
 * session cookie created by /admin/api/session. Cookie-authenticated mutations
 * additionally require the session's CSRF token.
 */

import type { Context } from "hono";
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
import { getUserById, type UserIdentity } from "../core/users.ts";

const LEGACY_SESSION_SUBJECTS = new Set([
  LOCAL_ADMIN_IDENTITY.id,
  GLOBAL_ADMIN_IDENTITY.id,
]);

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
    return identityFromSession(session);
  }

  const user = getUserById(session.sub);
  if (!user || user.revoked_at || user.role !== "admin") return null;

  return {
    id: user.id,
    label: user.label,
    role: user.role,
    rateLimitRpm: 0,
    maxConcurrency: 0,
    legacy: false,
  };
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

  if (MUTATING_METHODS.has(c.req.method.toUpperCase())) {
    const origin = c.req.header("origin");
    if (origin) {
      let expected: string | null = null;
      try {
        expected = new URL(c.req.url).origin;
      } catch {
        expected = null;
      }
      if (expected && origin !== expected) {
        return {
          response: adminJsonError(
            c,
            403,
            "Cross-origin dashboard mutation rejected",
          ),
        };
      }
    }
    if (!validateCsrf(session, c.req.header("x-csrf-token"))) {
      return { response: adminJsonError(c, 403, "Invalid CSRF token") };
    }
  }

  return {
    identity,
    via: "session",
    session,
  };
}
