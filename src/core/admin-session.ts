/**
 * Signed admin session cookies for the web dashboard.
 *
 * The cookie carries a compact JSON payload signed with HMAC-SHA256. The signing
 * secret is generated once and persisted under the data directory with mode
 * 0600, so sessions survive a process restart without ever storing the operator
 * credential in the browser.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDbDir } from "./paths.ts";
import type { UserIdentity } from "./users.ts";

export const ADMIN_SESSION_COOKIE = "qpx_admin";
export const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface AdminSessionPayload {
  sub: string;
  label: string;
  role: "admin" | "user";
  csrf: string;
  iat: number;
  exp: number;
}

export interface CreatedAdminSession {
  token: string;
  payload: AdminSessionPayload;
  csrf: string;
  expiresAt: number;
}

let cachedSecret: string | null = null;

function loadSessionSecret(): string {
  if (cachedSecret) return cachedSecret;
  const dir = getDbDir();
  const file = path.join(dir, ".admin_session_secret");
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8").trim();
      if (raw.length >= 32) {
        cachedSecret = raw;
        return raw;
      }
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const generated = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(file, generated, { mode: 0o600 });
    cachedSecret = generated;
    return generated;
  } catch (error) {
    console.warn(
      "⚠️  [Admin] Could not persist the session secret; sessions will not survive a restart:",
      error instanceof Error ? error.message : String(error),
    );
    cachedSecret = crypto.randomBytes(32).toString("hex");
    return cachedSecret;
  }
}

export function resetSessionSecretForTests(): void {
  cachedSecret = null;
}

function sign(body: string): string {
  return crypto
    .createHmac("sha256", loadSessionSecret())
    .update(body)
    .digest("base64url");
}

function timingSafeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function createAdminSession(
  identity: UserIdentity,
  ttlSeconds = DEFAULT_SESSION_TTL_SECONDS,
): CreatedAdminSession {
  const now = Math.floor(Date.now() / 1000);
  const payload: AdminSessionPayload = {
    sub: identity.id,
    label: identity.label,
    role: identity.role,
    csrf: crypto.randomBytes(24).toString("base64url"),
    iat: now,
    exp: now + Math.max(60, ttlSeconds),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return {
    token: `${body}.${sign(body)}`,
    payload,
    csrf: payload.csrf,
    expiresAt: payload.exp * 1000,
  };
}

export function verifyAdminSession(
  token: string | undefined | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): AdminSessionPayload | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;
  if (!timingSafeEqualString(signature, sign(body))) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as AdminSessionPayload;
    if (!payload || payload.role !== "admin") return null;
    if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) return null;
    if (typeof payload.iat !== "number") return null;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    if (typeof payload.csrf !== "string" || !payload.csrf) return null;
    return payload;
  } catch {
    return null;
  }
}

export function identityFromSession(
  payload: AdminSessionPayload,
): UserIdentity {
  return {
    id: payload.sub,
    label: payload.label,
    role: payload.role,
    rateLimitRpm: 0,
    maxConcurrency: 0,
    legacy: false,
  };
}

export function readSessionCookie(
  cookieHeader: string | undefined,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (name !== ADMIN_SESSION_COOKIE) continue;
    return part.slice(separator + 1).trim() || null;
  }
  return null;
}

function cookieAttributes(maxAgeSeconds: number, secure: boolean): string[] {
  const attributes = [
    "Path=/admin",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes;
}

export function buildSessionCookie(
  token: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  return [
    `${ADMIN_SESSION_COOKIE}=${token}`,
    ...cookieAttributes(maxAgeSeconds, secure),
  ].join("; ");
}

export function buildClearedSessionCookie(secure: boolean): string {
  return [
    `${ADMIN_SESSION_COOKIE}=`,
    ...cookieAttributes(0, secure),
  ].join("; ");
}

export function isSecureRequest(
  url: string,
  forwardedProto?: string | null,
): boolean {
  if (forwardedProto?.split(",")[0]?.trim().toLowerCase() === "https") {
    return true;
  }
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function validateCsrf(
  payload: AdminSessionPayload,
  provided: string | undefined | null,
): boolean {
  return Boolean(provided) && timingSafeEqualString(provided!, payload.csrf);
}
