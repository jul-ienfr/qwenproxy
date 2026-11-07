/**
 * Rolling one-minute counters for the dashboard overview.
 *
 * Metrics counters are cumulative, which is right for Prometheus but not for a
 * "requests per minute" KPI. These lightweight sliding windows are process-local
 * and updated from the global request middleware.
 */

const WINDOW_MS = 60_000;
const requests: number[] = [];
const errors: number[] = [];
const MAX_SAMPLES = 20_000;

function prune(list: number[], cutoff: number): void {
  while (list.length > 0 && list[0] <= cutoff) list.shift();
}

function push(list: number[], now: number): void {
  list.push(now);
  if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
}

export function recordOverviewRequest(now = Date.now()): void {
  push(requests, now);
}

export function recordOverviewError(now = Date.now()): void {
  push(errors, now);
}

export function getOverviewWindows(now = Date.now()): {
  requestCount: number;
  errorCount: number;
} {
  const cutoff = now - WINDOW_MS;
  prune(requests, cutoff);
  prune(errors, cutoff);
  return { requestCount: requests.length, errorCount: errors.length };
}

export function resetOverviewWindowsForTests(): void {
  requests.length = 0;
  errors.length = 0;
}
