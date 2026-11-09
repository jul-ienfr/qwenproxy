/**
 * Dashboard auto-login for the desktop webview.
 *
 * The GUI opens the normal `/admin` dashboard, which requires an admin session.
 * Rather than typing the API key inside the embedded browser, the GUI creates a
 * session through the existing `POST /admin/api/session` endpoint and injects
 * the resulting `qpx_admin` cookie into the webview.
 *
 * The API key is only ever sent to a loopback target: a remote `HOST` would put
 * the operator credential on the network and is left to the normal login form.
 */

import { ADMIN_SESSION_COOKIE } from "../core/admin-session.ts";
import { isLoopbackHost } from "../core/local-auth.ts";
import type { ServerTarget } from "./server-manager.ts";

export interface DashboardCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

/** Minimal surface of `@webviewjs/webview`'s Webview used for login. */
export interface DashboardAuthSink {
  setCookie(cookie: DashboardCookie): void;
}

export interface DashboardAuthOptions {
  target: ServerTarget;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type DashboardAuthResult =
  | { ok: true; cookie: DashboardCookie }
  | { ok: false; reason: string };

const DEFAULT_TIMEOUT_MS = 5_000;

class DashboardAuthTimeout extends Error {}

function readSetCookieHeaders(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof extended.getSetCookie === "function") {
    const values = extended.getSetCookie();
    if (values.length > 0) return values;
  }
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function parseCookieHeader(header: string): { name: string; value: string } | null {
  const first = header.split(";")[0] ?? "";
  const separator = first.indexOf("=");
  if (separator <= 0) return null;
  const name = first.slice(0, separator).trim();
  const value = first.slice(separator + 1).trim();
  if (!name || !value) return null;
  return { name, value };
}

function findSessionCookie(headers: Headers): string | null {
  for (const header of readSetCookieHeaders(headers)) {
    const parsed = parseCookieHeader(header);
    if (parsed?.name === ADMIN_SESSION_COOKIE) return parsed.value;
  }
  return null;
}

/**
 * Creates an admin session and injects its cookie into the webview.
 * Never throws: the caller can fall back to the dashboard login form.
 */
export async function loginDashboard(
  sink: DashboardAuthSink,
  options: DashboardAuthOptions,
): Promise<DashboardAuthResult> {
  const { target } = options;
  if (!isLoopbackHost(target.host)) {
    return { ok: false, reason: "remote-host" };
  }

  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DashboardAuthTimeout());
    }, timeoutMs);
    timer.unref?.();
  });

  let response: Response;
  try {
    response = await Promise.race([
      fetchImpl(`${target.origin}/admin/api/session`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ apiKey: options.apiKey }),
        signal: controller.signal,
        cache: "no-store",
      }),
      timeout,
    ]);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof DashboardAuthTimeout ? "timeout" : "network-error",
    };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response.ok) {
    return { ok: false, reason: `status-${response.status}` };
  }

  const value = findSessionCookie(response.headers);
  if (!value) {
    return { ok: false, reason: "missing-cookie" };
  }

  const cookie: DashboardCookie = {
    name: ADMIN_SESSION_COOKIE,
    value,
    domain: target.host,
    path: "/",
    httpOnly: true,
    secure: target.origin.startsWith("https:"),
    sameSite: "strict",
  };
  try {
    sink.setCookie(cookie);
  } catch {
    return { ok: false, reason: "cookie-rejected" };
  }
  return { ok: true, cookie };
}
