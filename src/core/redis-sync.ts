/**
 * Bridges Redis persistence events to the local SQLite snapshot and in-memory
 * caches.
 *
 * Local writes still go through the existing synchronous SQLite call sites; the
 * publish hooks live next to those writes. This module only applies events that
 * ORIGINATED on another instance, so an instance never double-applies its own
 * mutations.
 */

import { getDatabase } from "./database.ts";
import { invalidateAccountsCache } from "./accounts.ts";
import { applyRemoteAccountCooldown } from "./account-manager.ts";
import {
  applyRemoteLogicalThreadState,
  applyRemoteLogicalThreadDelete,
  applyRemoteSessionParent,
  applyRemoteSessionParentDelete,
  getAllSessionParents,
} from "../services/qwen-thread-state.ts";
import {
  RESPONSE_RETENTION_MS,
  applyRemoteStoredResponse,
  applyRemoteStoredResponseDelete,
} from "../routes/responses/state.ts";
import type {
  RedisEventHandlers,
  RedisLocalSnapshot,
  RedisPersistenceEvent,
} from "./redis-store.ts";

interface AccountRow {
  id: string;
  email: string;
  password: string;
  proxy?: string | null;
  cooldown_until?: number | null;
  cooldown_reason?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface UserRow {
  id: string;
  label: string;
  api_key_hash: string;
  api_key_prefix: string;
  role: string;
  rate_limit_rpm: number;
  max_concurrency: number;
  created_at?: string;
  updated_at?: string;
  revoked_at?: string | null;
}

interface UsageEvent {
  accountId?: string;
  dateUtc?: string;
  promptTokens?: number;
  completionTokens?: number;
  weightedTokens?: number;
  totalTokens?: number;
  turnsCount?: number;
}

function applyAccount(event: RedisPersistenceEvent): void {
  const id = event.id;
  if (!id) return;
  if (event.op === "delete") {
    getDatabase().prepare("DELETE FROM accounts WHERE id = ?").run(id);
    invalidateAccountsCache();
    applyRemoteAccountCooldown(id, 0, null);
    return;
  }

  const row = event.data as AccountRow | undefined;
  if (!row || typeof row.email !== "string") return;
  const cooldownUntil = Number(row.cooldown_until) || 0;
  const cooldownReason = row.cooldown_reason ?? null;
  getDatabase()
    .prepare(
      `INSERT INTO accounts (id, email, password, proxy, cooldown_until, cooldown_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         password = excluded.password,
         proxy = excluded.proxy,
         cooldown_until = excluded.cooldown_until,
         cooldown_reason = excluded.cooldown_reason,
         updated_at = excluded.updated_at`,
    )
    .run(
      id,
      row.email,
      row.password ?? "",
      row.proxy ?? null,
      cooldownUntil,
      cooldownReason,
      row.created_at ?? null,
      row.updated_at ?? null,
    );
  invalidateAccountsCache();
  applyRemoteAccountCooldown(id, cooldownUntil, cooldownReason);
}

function applyUser(event: RedisPersistenceEvent): void {
  const id = event.id;
  if (!id) return;
  if (event.op === "delete") {
    getDatabase().prepare("DELETE FROM users WHERE id = ?").run(id);
    return;
  }
  const row = event.data as UserRow | undefined;
  if (!row || typeof row.label !== "string") return;
  getDatabase()
    .prepare(
      `INSERT INTO users (id, label, api_key_hash, api_key_prefix, role, rate_limit_rpm, max_concurrency, created_at, updated_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')), ?)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label,
         api_key_hash = excluded.api_key_hash,
         api_key_prefix = excluded.api_key_prefix,
         role = excluded.role,
         rate_limit_rpm = excluded.rate_limit_rpm,
         max_concurrency = excluded.max_concurrency,
         updated_at = excluded.updated_at,
         revoked_at = excluded.revoked_at`,
    )
    .run(
      id,
      row.label,
      row.api_key_hash,
      row.api_key_prefix,
      row.role || "user",
      Number(row.rate_limit_rpm) || 0,
      Number(row.max_concurrency) || 0,
      row.created_at ?? null,
      row.updated_at ?? null,
      row.revoked_at ?? null,
    );
}

function applyUsage(event: RedisPersistenceEvent): void {
  const usage = event.data as UsageEvent | undefined;
  if (!usage?.accountId || !usage?.dateUtc) return;
  if (event.op === "delete") {
    getDatabase()
      .prepare(
        "DELETE FROM account_daily_usage WHERE account_id = ? AND date_utc = ?",
      )
      .run(usage.accountId, usage.dateUtc);
    return;
  }

  const prompt = Math.max(0, Number(usage.promptTokens) || 0);
  const completion = Math.max(0, Number(usage.completionTokens) || 0);
  const weighted = Math.max(0, Number(usage.weightedTokens) || 0);
  const total = Math.max(0, Number(usage.totalTokens) || 0);
  const turns = Math.max(0, Number(usage.turnsCount) || 0);

  if (event.op === "delta") {
    getDatabase()
      .prepare(
        `INSERT INTO account_daily_usage (
           account_id, date_utc, prompt_tokens, completion_tokens, weighted_tokens, total_tokens, turns_count, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(account_id, date_utc) DO UPDATE SET
           prompt_tokens = prompt_tokens + excluded.prompt_tokens,
           completion_tokens = completion_tokens + excluded.completion_tokens,
           weighted_tokens = weighted_tokens + excluded.weighted_tokens,
           total_tokens = total_tokens + excluded.total_tokens,
           turns_count = turns_count + excluded.turns_count,
           updated_at = datetime('now')`,
      )
      .run(usage.accountId, usage.dateUtc, prompt, completion, weighted, total, turns);
    return;
  }

  getDatabase()
    .prepare(
      `INSERT INTO account_daily_usage (
         account_id, date_utc, prompt_tokens, completion_tokens, weighted_tokens, total_tokens, turns_count, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(account_id, date_utc) DO UPDATE SET
         prompt_tokens = excluded.prompt_tokens,
         completion_tokens = excluded.completion_tokens,
         weighted_tokens = excluded.weighted_tokens,
         total_tokens = excluded.total_tokens,
         turns_count = excluded.turns_count,
         updated_at = datetime('now')`,
    )
    .run(usage.accountId, usage.dateUtc, prompt, completion, weighted, total, turns);
}

function applySession(event: RedisPersistenceEvent): void {
  if (event.op === "delete") {
    applyRemoteLogicalThreadDelete(event.id);
    return;
  }
  applyRemoteLogicalThreadState(event.id, (event.data || {}) as any);
}

function applyParent(event: RedisPersistenceEvent): void {
  if (event.op === "delete") {
    applyRemoteSessionParentDelete(event.id);
    return;
  }
  applyRemoteSessionParent(event.id, (event.data || {}) as any);
}

function applyResponse(event: RedisPersistenceEvent): void {
  if (event.op === "delete") {
    applyRemoteStoredResponseDelete(event.id);
    return;
  }
  applyRemoteStoredResponse(event.id, (event.data || {}) as any);
}

export function createRedisHandlers(): RedisEventHandlers {
  return {
    apply(event: RedisPersistenceEvent): void {
      switch (event.entity) {
        case "account":
          applyAccount(event);
          break;
        case "user":
          applyUser(event);
          break;
        case "usage":
          applyUsage(event);
          break;
        case "session":
          applySession(event);
          break;
        case "parent":
          applyParent(event);
          break;
        case "response":
          applyResponse(event);
          break;
      }
    },
  };
}

/** Raw local rows used to bootstrap an empty Redis instance. */
export function getLocalSnapshot(): RedisLocalSnapshot {
  const db = getDatabase();
  const accounts = db.prepare("SELECT * FROM accounts").all() as unknown[];
  const users = db.prepare("SELECT * FROM users").all() as unknown[];
  const sessions = db
    .prepare(
      "SELECT session_id, account_id, chat_session_id, parent_id, instructions_sent, updated_at FROM logical_thread_states",
    )
    .all() as unknown[];
  const usage = db
    .prepare("SELECT * FROM account_daily_usage")
    .all() as unknown[];
  let responses: unknown[] = [];
  try {
    // Do not bootstrap expired rows into Redis: the retention window applies to
    // the shared snapshot too, otherwise stale responses would be resurrected.
    responses = db
      .prepare("SELECT * FROM responses_store WHERE stored_at >= ?")
      .all(Date.now() - RESPONSE_RETENTION_MS) as unknown[];
  } catch {
    // The Responses table is created lazily on first use.
  }
  return {
    accounts,
    users,
    sessions,
    parents: getAllSessionParents(),
    usage,
    responses,
  };
}
