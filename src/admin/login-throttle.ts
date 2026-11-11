/**
 * Failed-login throttle for the dashboard session endpoint.
 *
 * The dashboard accepts the global API_KEY and per-user credentials, so a
 * remote caller can brute-force guesses against /admin/api/session. Keep a
 * process-local sliding window of failures per source address; a successful
 * login clears the window. The dashboard is a single-operator surface, so the
 * extra shared state a multi-instance throttle would need is not warranted.
 */

export const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000;
export const LOGIN_MAX_FAILURES = 10;
const MAX_TRACKED_KEYS = 5_000;

const failures = new Map<string, number[]>();

function recentFailures(key: string, now: number): number[] {
  const kept = (failures.get(key) ?? []).filter((ts) => ts > now - LOGIN_FAILURE_WINDOW_MS);
  if (kept.length === 0) failures.delete(key);
  else failures.set(key, kept);
  return kept;
}

function pruneAll(now: number): void {
  for (const key of [...failures.keys()]) recentFailures(key, now);
  if (failures.size < MAX_TRACKED_KEYS) return;
  // An attacker rotating addresses must not grow this map without bound. The
  // oldest tracked keys are dropped; a legitimate operator retries and the
  // window rebuilds.
  const excess = failures.size - MAX_TRACKED_KEYS;
  let dropped = 0;
  for (const key of failures.keys()) {
    failures.delete(key);
    if (++dropped >= excess) break;
  }
}

export interface LoginThrottleDecision {
  allowed: boolean;
  retryAfterSec?: number;
}

export function checkLoginThrottle(
  key: string,
  now = Date.now(),
): LoginThrottleDecision {
  const recent = recentFailures(key, now);
  if (recent.length < LOGIN_MAX_FAILURES) return { allowed: true };
  const oldest = recent[0] ?? now;
  return {
    allowed: false,
    retryAfterSec: Math.max(1, Math.ceil((oldest + LOGIN_FAILURE_WINDOW_MS - now) / 1000)),
  };
}

export function recordLoginFailure(key: string, now = Date.now()): void {
  if (failures.size >= MAX_TRACKED_KEYS) pruneAll(now);
  const recent = recentFailures(key, now);
  recent.push(now);
  failures.set(key, recent);
}

export function clearLoginFailures(key: string): void {
  failures.delete(key);
}

/** Test-only hook: keep throttle state from leaking between test cases. */
export function resetLoginThrottleForTests(): void {
  failures.clear();
}
