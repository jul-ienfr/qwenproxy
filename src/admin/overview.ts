/**
 * Read-only dashboard snapshots.
 *
 * Everything here is derived from existing proxy state; no upstream call is
 * made, so the dashboard stays reachable when Qwen is down.
 */

import v8 from "node:v8";
import { metrics } from "../core/metrics.ts";
import { loadAccounts } from "../core/accounts.ts";
import { getHeadersReadyAccountIds } from "../core/account-manager.ts";
import { getActivePlaywrightAccountIds } from "../services/playwright.ts";
import { listUsers } from "../core/users.ts";
import { getPoolDailyUsageSummary } from "../core/daily-usage.ts";
import { getOverviewWindows } from "../core/overview-stats.ts";
import { getRuntimeChatMode } from "../core/config.ts";

export interface AccountSnapshot {
  id: string;
  email: string;
  proxy: string | null;
  cooldown_until: number;
  cooldown_reason: string | null;
  cooldown_remaining_ms: number;
  headers_ready: boolean;
  active: boolean;
}

export function maskAccountEmail(email: string): string {
  const value = (email || "").trim();
  const at = value.indexOf("@");
  if (at <= 0) return "***";
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}

export function buildAccountSnapshots(now = Date.now()): AccountSnapshot[] {
  const ready = new Set(getHeadersReadyAccountIds());
  const active = new Set(getActivePlaywrightAccountIds());
  return loadAccounts().map((account) => {
    const until = account.cooldown_until ?? 0;
    const remaining = until > now ? until - now : 0;
    return {
      id: account.id,
      email: maskAccountEmail(account.email),
      proxy: account.proxy ?? null,
      cooldown_until: until,
      cooldown_reason: remaining > 0 ? (account.cooldown_reason ?? null) : null,
      cooldown_remaining_ms: remaining,
      headers_ready: ready.has(account.id),
      active: active.has(account.id),
    };
  });
}

function numericMetric(name: string): number {
  const value = metrics.get(name)?.value;
  return typeof value === "number" ? value : 0;
}

function averageLatencyMs(): number {
  const histogram = metrics.get("latency.request")?.value as
    | { count?: number; sum?: number }
    | undefined;
  if (!histogram || !histogram.count) return 0;
  return Math.round((histogram.sum ?? 0) / histogram.count);
}

export function buildOverview(now = Date.now()) {
  const accounts = buildAccountSnapshots(now);
  const cooldownCount = accounts.filter(
    (account) => account.cooldown_remaining_ms > 0,
  ).length;
  const windows = getOverviewWindows(now);
  const users = listUsers();
  const memory = process.memoryUsage();
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  const usage = getPoolDailyUsageSummary();
  const watchdog = numericMetric("watchdog.overall");

  const errorRatePercent =
    windows.requestCount > 0
      ? (windows.errorCount / windows.requestCount) * 100
      : 0;

  return {
    status:
      watchdog >= 2 ? "unhealthy" : watchdog >= 1 ? "degraded" : "healthy",
    version: process.env.npm_package_version || "dev",
    uptimeSec: Math.round(process.uptime()),
    timestamp: now,
    chatMode: getRuntimeChatMode(),
    accounts: {
      total: accounts.length,
      ready: accounts.filter((account) => account.headers_ready).length,
      active: accounts.filter((account) => account.active).length,
      cooldown: cooldownCount,
      list: accounts,
    },
    streams: {
      active: numericMetric("streams.active"),
      errors: numericMetric("streams.errors"),
    },
    requests: {
      total: numericMetric("requests.total"),
      cumulativeErrors: numericMetric("requests.errors"),
      rpm: windows.requestCount,
      errorsPerMinute: windows.errorCount,
      errorRatePercent: Number(errorRatePercent.toFixed(2)),
    },
    latency: {
      avgMs: averageLatencyMs(),
    },
    memory: {
      rssMb: Number((memory.rss / 1_048_576).toFixed(1)),
      heapUsedMb: Number((memory.heapUsed / 1_048_576).toFixed(1)),
      heapLimitMb: Number((heapLimit / 1_048_576).toFixed(0)),
      heapUsagePercent: Number(
        ((memory.heapUsed / Math.max(1, heapLimit)) * 100).toFixed(2),
      ),
    },
    usage,
    users: {
      total: users.length,
      active: users.filter((user) => !user.revoked_at).length,
      admins: users.filter((user) => user.role === "admin" && !user.revoked_at)
        .length,
    },
  };
}
