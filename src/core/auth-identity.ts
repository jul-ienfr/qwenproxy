/**
 * Shared request-identity resolution.
 *
 * The proxy accepts three credential sources, in order:
 *   1. the legacy global `API_KEY` (admin),
 *   2. a hashed per-user key from SQLite,
 *   3. the historical loopback no-auth fallback (local admin).
 *
 * Keeping this in one module lets the OpenAI/Anthropic middleware and the
 * dashboard login agree on exactly the same rules.
 */

import crypto from "node:crypto";
import { config } from "./config.ts";
import { getRuntimeApiKey, isPlaceholderApiKey } from "./local-auth.ts";
import {
  findUserByKeyIncludingRevoked,
  looksLikeProxyApiKey,
  type UserIdentity,
} from "./users.ts";

export const LOCAL_ADMIN_IDENTITY: UserIdentity = {
  id: "local-admin",
  label: "Local operator",
  role: "admin",
  rateLimitRpm: 0,
  maxConcurrency: 0,
  legacy: true,
};

export const GLOBAL_ADMIN_IDENTITY: UserIdentity = {
  id: "global-admin",
  label: "API_KEY operator",
  role: "admin",
  rateLimitRpm: 0,
  maxConcurrency: 0,
  legacy: true,
};

export type IdentityError = "invalid" | "missing" | "revoked";

export interface IdentityResolution {
  identity?: UserIdentity;
  error?: IdentityError;
}

export function constantTimeStringEqual(
  provided: string,
  expected: string,
): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  const providedHash = crypto.createHash("sha256").update(providedBuf).digest();
  const expectedHash = crypto.createHash("sha256").update(expectedBuf).digest();

  return (
    crypto.timingSafeEqual(providedHash, expectedHash) &&
    providedBuf.length === expectedBuf.length
  );
}

/** Accept OpenAI-style Bearer and x-api-key. */
export function extractProvidedApiKeys(headers: {
  authorization?: string;
  apiKey?: string;
}): string[] {
  const keys: string[] = [];
  const auth = headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token) keys.push(token);
  }
  const xApiKey = headers.apiKey?.trim();
  if (xApiKey) keys.push(xApiKey);
  return keys;
}

export function resolveIdentity(candidates: string[]): IdentityResolution {
  const apiKey = (getRuntimeApiKey() || config.apiKey || "").trim();
  const apiKeyConfigured = !isPlaceholderApiKey(apiKey);

  if (
    apiKeyConfigured &&
    candidates.some((token) => constantTimeStringEqual(token, apiKey))
  ) {
    return { identity: GLOBAL_ADMIN_IDENTITY };
  }

  for (const token of candidates) {
    const user = findUserByKeyIncludingRevoked(token);
    if (!user) continue;
    if (user.revoked_at) return { error: "revoked" };
    return {
      identity: {
        id: user.id,
        label: user.label,
        role: user.role,
        rateLimitRpm: user.rate_limit_rpm,
        maxConcurrency: user.max_concurrency,
        legacy: false,
      },
    };
  }

  // Preserve the historical loopback behavior: with no configured API_KEY the
  // local operator is trusted and unrelated stray credentials are ignored.
  // Keys minted by this proxy are never ignored: a rotated-out key must not
  // fall back to local-admin trust.
  if (!apiKeyConfigured) {
    if (candidates.some(looksLikeProxyApiKey)) return { error: "invalid" };
    return { identity: LOCAL_ADMIN_IDENTITY };
  }

  return { error: candidates.length > 0 ? "invalid" : "missing" };
}

export function identityErrorMessage(error: IdentityError): string {
  switch (error) {
    case "revoked":
      return "API key revoked";
    case "invalid":
      return "Invalid API key";
    default:
      return "Missing or invalid credentials (Authorization Bearer or x-api-key)";
  }
}
