import type { ResponsesResponse } from "./types.ts";
import { getDatabase } from "../../core/database.ts";
import { publishRedisEvent } from "../../core/redis-store.ts";

// ============ State management for previous_response_id ============
//
// The Responses API supports stateful conversations via `previous_response_id`.
// We store completed responses in SQLite (durable) with an in-memory LRU cache
// for fast lookups. This ensures memory persists across server restarts.

export interface StoredResponse {
  response: ResponsesResponse;
  /** The full list of Chat Completions messages sent to the upstream for this response */
  chatMessages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
  }>;
  /** Identity that created the response; null for pre-ownership rows. */
  ownerId?: string | null;
  /** Timestamp of storage */
  storedAt: number;
}

// In-memory LRU cache (responseId → StoredResponse)
const cache = new Map<string, StoredResponse>();
const MAX_CACHE_SIZE = 500;
// Max age (ms) - 7 days for SQLite, 24h for cache
export const RESPONSE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_AGE_MS = RESPONSE_RETENTION_MS;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

let tableReady = false;

function ensureTable(): void {
  if (tableReady) return;
  try {
    const db = getDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS responses_store (
        response_id TEXT PRIMARY KEY,
        response_json TEXT NOT NULL,
        chat_messages_json TEXT NOT NULL,
        owner_id TEXT,
        stored_at INTEGER NOT NULL
      )
    `);
    // Upgrade databases created before responses were owner-scoped. Existing
    // rows keep a NULL owner so single-operator deployments can still read them.
    try {
      db.exec(`ALTER TABLE responses_store ADD COLUMN owner_id TEXT`);
    } catch {
      // Column already exists.
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_responses_store_stored_at
      ON responses_store(stored_at)
    `);
    tableReady = true;
  } catch {
    // Database not available — fall back to memory-only
    tableReady = false;
  }
}

/**
 * Drop expired rows and cache entries. Reads already treat stale entries as
 * missing; this bounds storage on long-running servers where a response is
 * stored once and never read again (the common case for stateless clients).
 */
export function pruneExpiredResponses(now = Date.now()): number {
  let removed = 0;
  for (const [id, entry] of cache) {
    if (now - entry.storedAt > CACHE_MAX_AGE_MS) {
      cache.delete(id);
      removed++;
    }
  }

  ensureTable();
  if (!tableReady) return removed;
  try {
    const result = getDatabase()
      .prepare(`DELETE FROM responses_store WHERE stored_at < ?`)
      .run(now - MAX_AGE_MS);
    removed += result.changes;
  } catch {
    // Retention is best effort; the lookup path still enforces the age check.
  }
  return removed;
}

/**
 * Store a completed response for future `previous_response_id` lookups.
 * Persists to SQLite + in-memory cache.
 */
export function storeResponse(
  responseId: string,
  response: ResponsesResponse,
  chatMessages: StoredResponse["chatMessages"],
  ownerId?: string,
): void {
  const entry: StoredResponse = {
    response,
    chatMessages,
    ownerId: ownerId ?? null,
    storedAt: Date.now(),
  };

  // In-memory cache (LRU eviction)
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = [...cache.entries()]
      .sort((a, b) => a[1].storedAt - b[1].storedAt)
      .slice(0, Math.floor(MAX_CACHE_SIZE * 0.1));
    for (const [key] of oldest) {
      cache.delete(key);
    }
  }
  cache.set(responseId, entry);

  const responseJson = JSON.stringify(response);
  const chatMessagesJson = JSON.stringify(chatMessages);

  // SQLite persistence
  ensureTable();
  const now = Date.now();
  if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
    lastPruneAt = now;
    pruneExpiredResponses(now);
  }
  if (tableReady) {
    try {
      const db = getDatabase();
      db.prepare(
        `INSERT OR REPLACE INTO responses_store (response_id, response_json, chat_messages_json, owner_id, stored_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        responseId,
        responseJson,
        chatMessagesJson,
        entry.ownerId ?? null,
        entry.storedAt,
      );
    } catch {
      // Non-fatal: memory cache still works
    }
  }

  publishRedisEvent("response", "upsert", responseId, {
    responseJson,
    chatMessagesJson,
    ownerId: entry.ownerId ?? null,
    storedAt: entry.storedAt,
  });
}

/**
 * Retrieve stored history for a `previous_response_id`.
 * Returns null if not found.
 */
export function getResponseHistory(
  previousResponseId: string,
  ownerId?: string,
): StoredResponse["chatMessages"] | null {
  // Check memory cache first. A cached entry owned by another identity must not
  // be returned even when the id is known.
  const cached = cache.get(previousResponseId);
  if (cached) {
    if (Date.now() - cached.storedAt > CACHE_MAX_AGE_MS) {
      cache.delete(previousResponseId);
    } else if (ownerId === undefined || cached.ownerId === ownerId) {
      return cached.chatMessages;
    }
  }

  // Fall back to SQLite
  ensureTable();
  if (!tableReady) return null;

  try {
    const db = getDatabase();
    const row =
      ownerId === undefined
        ? (db
            .prepare(
              `SELECT chat_messages_json, owner_id, stored_at FROM responses_store WHERE response_id = ?`,
            )
            .get(previousResponseId) as
            | {
                chat_messages_json: string;
                owner_id: string | null;
                stored_at: number;
              }
            | undefined)
        : (db
            .prepare(
              `SELECT chat_messages_json, owner_id, stored_at FROM responses_store WHERE response_id = ? AND owner_id = ?`,
            )
            .get(previousResponseId, ownerId) as
            | {
                chat_messages_json: string;
                owner_id: string | null;
                stored_at: number;
              }
            | undefined);

    if (!row) return null;

    if (Date.now() - row.stored_at > MAX_AGE_MS) {
      db.prepare(`DELETE FROM responses_store WHERE response_id = ?`).run(
        previousResponseId,
      );
      return null;
    }

    const chatMessages = JSON.parse(row.chat_messages_json);
    // Re-populate cache
    const responseRow = db
      .prepare(`SELECT response_json FROM responses_store WHERE response_id = ?`)
      .get(previousResponseId) as { response_json: string } | undefined;
    if (responseRow) {
      cache.set(previousResponseId, {
        response: JSON.parse(responseRow.response_json),
        chatMessages,
        ownerId: row.owner_id,
        storedAt: row.stored_at,
      });
    }

    return chatMessages;
  } catch {
    return null;
  }
}

/**
 * Retrieve the full stored response (for GET /v1/responses/:id).
 * Returns null if not found.
 */
export function getStoredResponse(
  responseId: string,
  ownerId?: string,
): ResponsesResponse | null {
  // Check memory cache first
  const cached = cache.get(responseId);
  if (cached) {
    if (Date.now() - cached.storedAt > CACHE_MAX_AGE_MS) {
      cache.delete(responseId);
    } else if (ownerId === undefined || cached.ownerId === ownerId) {
      return cached.response;
    }
  }

  // Fall back to SQLite
  ensureTable();
  if (!tableReady) return null;

  try {
    const db = getDatabase();
    const row =
      ownerId === undefined
        ? (db
            .prepare(
              `SELECT response_json, chat_messages_json, stored_at FROM responses_store WHERE response_id = ?`,
            )
            .get(responseId) as
            | {
                response_json: string;
                chat_messages_json: string;
                stored_at: number;
              }
            | undefined)
        : (db
            .prepare(
              `SELECT response_json, chat_messages_json, stored_at FROM responses_store WHERE response_id = ? AND owner_id = ?`,
            )
            .get(responseId, ownerId) as
            | {
                response_json: string;
                chat_messages_json: string;
                stored_at: number;
              }
            | undefined);

    if (!row) return null;

    if (Date.now() - row.stored_at > MAX_AGE_MS) {
      db.prepare(`DELETE FROM responses_store WHERE response_id = ?`).run(
        responseId,
      );
      return null;
    }

    return JSON.parse(row.response_json);
  } catch {
    return null;
  }
}

/**
 * Delete a stored response.
 */
export function deleteStoredResponse(
  responseId: string,
  ownerId?: string,
): boolean {
  const cached = cache.get(responseId);
  const cacheMatchesOwner =
    cached !== undefined && (ownerId === undefined || cached.ownerId === ownerId);
  const fromCache = cacheMatchesOwner ? cache.delete(responseId) : false;

  ensureTable();
  let removed = fromCache;
  if (tableReady) {
    try {
      const db = getDatabase();
      const result =
        ownerId === undefined
          ? db
              .prepare(`DELETE FROM responses_store WHERE response_id = ?`)
              .run(responseId)
          : db
              .prepare(
                `DELETE FROM responses_store WHERE response_id = ? AND owner_id = ?`,
              )
              .run(responseId, ownerId);
      removed = fromCache || result.changes > 0;
    } catch {
      removed = fromCache;
    }
  }

  // Only broadcast a deletion that actually happened: the id may belong to a
  // different identity, and remote instances would otherwise drop that row.
  if (removed) {
    publishRedisEvent("response", "delete", responseId);
  }
  return removed;
}

/** Apply a stored response received from another instance. */
export function applyRemoteStoredResponse(
  responseId: string,
  payload: {
    responseJson?: string;
    chatMessagesJson?: string;
    ownerId?: string | null;
    storedAt?: number;
  },
): void {
  if (!responseId || !payload?.responseJson || !payload?.chatMessagesJson) {
    return;
  }
  try {
    const entry: StoredResponse = {
      response: JSON.parse(payload.responseJson),
      chatMessages: JSON.parse(payload.chatMessagesJson),
      ownerId: payload.ownerId ?? null,
      storedAt: Number(payload.storedAt) || Date.now(),
    };
    if (cache.size >= MAX_CACHE_SIZE) {
      const oldest = [...cache.entries()]
        .sort((a, b) => a[1].storedAt - b[1].storedAt)
        .slice(0, Math.floor(MAX_CACHE_SIZE * 0.1));
      for (const [key] of oldest) cache.delete(key);
    }
    cache.set(responseId, entry);

    ensureTable();
    if (tableReady) {
      getDatabase()
        .prepare(
          `INSERT OR REPLACE INTO responses_store (response_id, response_json, chat_messages_json, owner_id, stored_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          responseId,
          payload.responseJson,
          payload.chatMessagesJson,
          entry.ownerId ?? null,
          entry.storedAt,
        );
    }
  } catch {
    // Ignore malformed remote payloads; the local snapshot stays authoritative.
  }
}

/** Apply a stored response deletion received from another instance. */
export function applyRemoteStoredResponseDelete(responseId: string): void {
  if (!responseId) return;
  cache.delete(responseId);
  ensureTable();
  if (!tableReady) return;
  try {
    getDatabase()
      .prepare(`DELETE FROM responses_store WHERE response_id = ?`)
      .run(responseId);
  } catch {}
}
