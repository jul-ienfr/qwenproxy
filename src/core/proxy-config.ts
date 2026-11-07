/**
 * Per-account outbound proxy parsing and resolution.
 *
 * Resolution order is account proxy -> global PROXY_URL -> direct. Proxy URLs
 * may carry credentials; callers must use the masking helpers before logging or
 * returning them to a client.
 */

import { config } from "./config.ts";

export interface ParsedProxy {
  /** scheme://host:port, without credentials */
  server: string;
  username?: string;
  password?: string;
  bypass?: string;
  /** Masked form suitable for logs and UI */
  display: string;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "socks5:", "socks5h:"]);

export function isProxyConfigured(value?: string | null): boolean {
  return Boolean(value && value.trim().length > 0);
}

/**
 * Parse and validate a proxy URL. Throws on malformed input so callers can
 * surface a precise error instead of silently falling back to direct egress.
 */
export function parseProxyUrl(raw?: string | null): ParsedProxy | null {
  if (!raw || !raw.trim()) return null;

  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `Invalid proxy URL "${maskProxyUrl(trimmed)}": expected scheme://host:port`,
    );
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(
      `Unsupported proxy scheme "${url.protocol}". Use http, https, socks5 or socks5h.`,
    );
  }

  if (!url.hostname) {
    throw new Error(`Invalid proxy URL "${maskProxyUrl(trimmed)}": missing host`);
  }
  if (!url.port) {
    throw new Error(
      `Invalid proxy URL "${maskProxyUrl(trimmed)}": missing port (for example :8080)`,
    );
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error(
      `Invalid proxy URL "${maskProxyUrl(trimmed)}": path, query and fragment are not supported`,
    );
  }

  let username: string | undefined;
  let password: string | undefined;
  try {
    username = url.username ? decodeURIComponent(url.username) : undefined;
    password = url.password ? decodeURIComponent(url.password) : undefined;
  } catch {
    throw new Error(
      `Invalid proxy URL "${maskProxyUrl(trimmed)}": malformed credentials`,
    );
  }

  return {
    server: `${url.protocol}//${url.hostname}:${url.port}`,
    username,
    password,
    display: maskProxyUrl(trimmed),
  };
}

/** Account proxy wins; otherwise the global fallback; otherwise direct. */
export function resolveProxyUrl(accountProxy?: string | null): string | undefined {
  if (isProxyConfigured(accountProxy)) return accountProxy!.trim();
  if (isProxyConfigured(config.proxy.url)) return config.proxy.url;
  return undefined;
}

/** Convert a proxy URL to the shape expected by Playwright/Patchright. */
export function toPlaywrightProxy(
  raw?: string | null,
): { server: string; username?: string; password?: string; bypass?: string } | undefined {
  const parsed = parseProxyUrl(raw);
  if (!parsed) return undefined;
  // Playwright documents socks5://; Chromium resolves the hostname through the
  // SOCKS proxy, which matches the socks5h intent. Normalize the scheme.
  const server = parsed.server.replace(/^socks5h:/, "socks5:");
  return {
    server,
    ...(parsed.username === undefined ? {} : { username: parsed.username }),
    ...(parsed.password === undefined ? {} : { password: parsed.password }),
    ...(parsed.bypass === undefined ? {} : { bypass: parsed.bypass }),
  };
}

/** Mask credentials for logs, CLI output and TUI display. */
export function maskProxyUrl(raw?: string | null): string {
  if (!raw || !raw.trim()) return "(direct)";
  try {
    const url = new URL(raw.trim());
    if (url.password) url.password = "***";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "(invalid proxy URL)";
  }
}

/** Parse `email=proxy,email=proxy` from QWEN_ACCOUNT_PROXIES. */
export function parseAccountProxyEnv(raw?: string | null): Map<string, string> {
  const result = new Map<string, string>();
  if (!raw || !raw.trim()) return result;
  for (const entry of raw.split(/[;\n]+/)) {
    const line = entry.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const email = line.slice(0, eq).trim().toLowerCase();
    const proxy = line.slice(eq + 1).trim();
    if (!email || !proxy) continue;
    try {
      parseProxyUrl(proxy);
      result.set(email, proxy);
    } catch {
      // Invalid entries are ignored during bootstrap; the CLI validates loudly.
    }
  }
  return result;
}
