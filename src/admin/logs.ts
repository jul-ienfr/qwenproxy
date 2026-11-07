/**
 * Secret redaction for dashboard log views.
 *
 * The raw server log buffer is intentionally lossless for local debugging; the
 * browser-facing surface must never echo API keys, bearer tokens, cookies or
 * proxy credentials.
 */

import type { ServerLogMessage } from "../core/server-log-buffer.ts";

const PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-***"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1***"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "***"],
  [
    /("?(?:password|passwd|api[_-]?key|apikey|token|secret|authorization|cookie|set-cookie)"?\s*[:=]\s*"?)([^"\s,}]+)/gi,
    "$1***",
  ],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1***:***@"],
];

export function redactLogText(text: string): string {
  let output = text;
  for (const [pattern, replacement] of PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function redactLogEntry(entry: ServerLogMessage): ServerLogMessage {
  return { ...entry, message: redactLogText(entry.message) };
}

export function redactLogHistory(
  entries: ServerLogMessage[],
  level: string | undefined,
  limit: number,
): ServerLogMessage[] {
  const normalized = (level || "all").toLowerCase();
  const filtered =
    normalized === "info" || normalized === "warn" || normalized === "error"
      ? entries.filter(
          (entry) => entry.level.toLowerCase() === normalized,
        )
      : entries;
  const bounded = Math.min(1000, Math.max(1, Math.trunc(limit) || 200));
  return filtered.slice(-bounded).map(redactLogEntry);
}
