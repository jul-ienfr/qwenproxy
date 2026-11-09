/**
 * QwenProxy - Real-time Daily Token & Quota Metrics Engine
 *
 * Tracks empirical per-account and pool-wide daily usage (prompt & completion tokens, turn counts)
 * keyed strictly by UTC date so it resets automatically every day at 00:00 UTC (21:00 BRT).
 *
 * INVARIANT: This is PURELY an observability / monitoring metric for the user.
 * It NEVER throttles, blocks, or rejects requests locally.
 */

import { getDatabase } from "./database.ts";
import { loadAccounts } from "./accounts.ts";
import { mapClientModelToQwen } from "./model-alias.ts";
import { publishRedisEvent } from "./redis-store.ts";

/**
 * Calibrated daily output-tokens baseline per account.
 * Standard baseline is based on the primary coding model (Plus family): 500,000 output tokens.
 */
export const STANDARD_DAILY_TOKEN_BASELINE = 500_000;
export const DAILY_ACCOUNT_TOKEN_BASELINE = STANDARD_DAILY_TOKEN_BASELINE; // backward-compat

export const MODEL_DAILY_OUTPUT_BASELINES: Record<string, number> = {
  max: 280_000,
  plus: 500_000,
  omni: 620_000,
};

/**
 * Returns the normalization weight for a model relative to the standard 500k Plus baseline.
 * - Max models (280k): 500/280 = ~1.7857x (consumes quota faster)
 * - Plus models (500k): 1.0x (standard baseline)
 * - Omni/Flash models (620k): 500/620 = ~0.8065x (lasts longer)
 */
export function getModelQuotaWeight(model?: string): number {
  if (!model) return 1.0;
  const resolved = mapClientModelToQwen(model).toLowerCase();
  if (resolved.includes("max")) {
    return STANDARD_DAILY_TOKEN_BASELINE / MODEL_DAILY_OUTPUT_BASELINES.max;
  }
  if (resolved.includes("omni") || resolved.includes("flash")) {
    return STANDARD_DAILY_TOKEN_BASELINE / MODEL_DAILY_OUTPUT_BASELINES.omni;
  }
  return 1.0;
}

export interface AccountDailyUsage {
  accountId: string;
  dateUtc: string;
  promptTokens: number;
  completionTokens: number;
  weightedTokens: number;
  totalTokens: number;
  turnsCount: number;
  usagePercent: number;
}

export interface PoolDailyUsageSummary {
  dateUtc: string;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalWeightedTokens: number;
  totalTokens: number;
  totalTurns: number;
  poolCapacityTokens: number;
  poolUsagePercent: number;
}

/** Formats a timestamp into YYYY-MM-DD in UTC timezone. */
export function getUtcDateString(timestampMs: number = Date.now()): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

/**
 * Records tokens and turn count for a given account on the current UTC date.
 * Automatically upserts into SQLite `account_daily_usage`.
 */
export function recordTurnUsage(
  accountId: string,
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  },
  modelOrDate?: string,
  maybeDateUtc?: string,
): void {
  if (!accountId || accountId === "global") return;

  let model: string | undefined;
  let dateUtc: string;

  if (modelOrDate && /^\d{4}-\d{2}-\d{2}$/.test(modelOrDate)) {
    dateUtc = modelOrDate;
    model = undefined;
  } else {
    model = modelOrDate;
    dateUtc = maybeDateUtc || getUtcDateString();
  }

  const prompt = Math.max(0, Number(usage.prompt_tokens) || 0);
  const completion = Math.max(0, Number(usage.completion_tokens) || 0);
  const total = Math.max(
    prompt + completion,
    Number(usage.total_tokens) || prompt + completion,
  );
  const weight = getModelQuotaWeight(model);
  const weighted = completion * weight;

  try {
    const db = getDatabase();
    db.prepare(
      `
      INSERT INTO account_daily_usage (
        account_id, date_utc, prompt_tokens, completion_tokens, weighted_tokens, total_tokens, turns_count, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, 1, datetime('now')
      )
      ON CONFLICT(account_id, date_utc) DO UPDATE SET
        prompt_tokens = prompt_tokens + excluded.prompt_tokens,
        completion_tokens = completion_tokens + excluded.completion_tokens,
        weighted_tokens = weighted_tokens + excluded.weighted_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        turns_count = turns_count + 1,
        updated_at = datetime('now')
    `,
    ).run(accountId, dateUtc, prompt, completion, weighted, total);

    // Other instances add the same delta to their local snapshot.
    publishRedisEvent("usage", "delta", `${accountId}:${dateUtc}`, {
      accountId,
      dateUtc,
      promptTokens: prompt,
      completionTokens: completion,
      weightedTokens: weighted,
      totalTokens: total,
      turnsCount: 1,
    });
  } catch (err: any) {
    // Non-fatal telemetry: never fail a user completion if DB recording fails
  }
}

/**
 * Returns today's usage statistics for a specific account.
 */
export function getAccountDailyUsage(
  accountId: string,
  dateUtc: string = getUtcDateString(),
): AccountDailyUsage {
  try {
    const db = getDatabase();
    const row = db
      .prepare(
        `SELECT prompt_tokens, completion_tokens, weighted_tokens, total_tokens, turns_count
         FROM account_daily_usage
         WHERE account_id = ? AND date_utc = ?`,
      )
      .get(accountId, dateUtc) as any;

    const promptTokens = Number(row?.prompt_tokens) || 0;
    const completionTokens = Number(row?.completion_tokens) || 0;
    const weightedTokens = Number(row?.weighted_tokens) || completionTokens;
    const totalTokens = Number(row?.total_tokens) || 0;
    const turnsCount = Number(row?.turns_count) || 0;

    const usagePercent = Math.min(
      100,
      Math.round((weightedTokens / STANDARD_DAILY_TOKEN_BASELINE) * 100),
    );

    return {
      accountId,
      dateUtc,
      promptTokens,
      completionTokens,
      weightedTokens,
      totalTokens,
      turnsCount,
      usagePercent,
    };
  } catch {
    return {
      accountId,
      dateUtc,
      promptTokens: 0,
      completionTokens: 0,
      weightedTokens: 0,
      totalTokens: 0,
      turnsCount: 0,
      usagePercent: 0,
    };
  }
}

/**
 * Returns daily usage mapped by account_id for the given UTC date.
 */
export function getAllAccountsDailyUsage(
  dateUtc: string = getUtcDateString(),
): Map<string, AccountDailyUsage> {
  const result = new Map<string, AccountDailyUsage>();
  try {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT account_id, prompt_tokens, completion_tokens, weighted_tokens, total_tokens, turns_count
         FROM account_daily_usage
         WHERE date_utc = ?`,
      )
      .all(dateUtc) as any[];

    for (const row of rows) {
      const promptTokens = Number(row.prompt_tokens) || 0;
      const completionTokens = Number(row.completion_tokens) || 0;
      const weightedTokens = Number(row.weighted_tokens) || completionTokens;
      const totalTokens = Number(row.total_tokens) || 0;
      const turnsCount = Number(row.turns_count) || 0;
      const usagePercent = Math.min(
        100,
        Math.round((weightedTokens / STANDARD_DAILY_TOKEN_BASELINE) * 100),
      );

      result.set(row.account_id, {
        accountId: row.account_id,
        dateUtc,
        promptTokens,
        completionTokens,
        weightedTokens,
        totalTokens,
        turnsCount,
        usagePercent,
      });
    }
  } catch {}
  return result;
}

/**
 * Computes the aggregate pool daily usage and percentage.
 */
export function getPoolDailyUsageSummary(
  targetAccountIds?: string[],
  dateUtc: string = getUtcDateString(),
): PoolDailyUsageSummary {
  const accounts =
    targetAccountIds && targetAccountIds.length > 0
      ? targetAccountIds
      : loadAccounts().map((a) => a.id);

  const accountCount = Math.max(1, accounts.length);
  const poolCapacityTokens = accountCount * STANDARD_DAILY_TOKEN_BASELINE;

  const usageMap = getAllAccountsDailyUsage(dateUtc);

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalWeightedTokens = 0;
  let totalTokens = 0;
  let totalTurns = 0;

  for (const id of accounts) {
    const usage = usageMap.get(id);
    if (usage) {
      totalPromptTokens += usage.promptTokens;
      totalCompletionTokens += usage.completionTokens;
      totalWeightedTokens += usage.weightedTokens;
      totalTokens += usage.totalTokens;
      totalTurns += usage.turnsCount;
    }
  }

  const poolUsagePercent = Math.min(
    100,
    Math.round((totalWeightedTokens / poolCapacityTokens) * 100),
  );

  return {
    dateUtc,
    totalPromptTokens,
    totalCompletionTokens,
    totalWeightedTokens,
    totalTokens,
    totalTurns,
    poolCapacityTokens,
    poolUsagePercent,
  };
}
