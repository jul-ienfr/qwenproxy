import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import {
  MemoryRedisTransport,
  RedisPersistence,
  getRedisHealth,
  isRedisPersistenceEnabled,
  redisEntityKey,
} from "../core/redis-store.ts";
import { createRedisHandlers, getLocalSnapshot } from "../core/redis-sync.ts";
import { getDatabase } from "../core/database.ts";
import { getAccountCooldownInfo } from "../core/account-manager.ts";
import { getLogicalThreadState } from "../services/qwen-thread-state.ts";
import { getAccountDailyUsage, getUtcDateString } from "../core/daily-usage.ts";
import { getResponseHistory } from "../routes/responses/state.ts";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function makePair(prefix: string) {
  const transport = new MemoryRedisTransport();
  const writer = new RedisPersistence({
    transport,
    handlers: { apply: () => undefined },
    prefix,
    instanceId: "writer",
    pollIntervalMs: 25,
  });
  const reader = new RedisPersistence({
    transport,
    handlers: createRedisHandlers(),
    prefix,
    instanceId: "reader",
    pollIntervalMs: 25,
  });
  await writer.start();
  await reader.start();
  return { transport, writer, reader };
}

async function stopPair(pair: {
  writer: RedisPersistence;
  reader: RedisPersistence;
}): Promise<void> {
  await pair.reader.stop().catch(() => undefined);
  await pair.writer.stop().catch(() => undefined);
}

test("SQLite mode reports no Redis dependency", () => {
  assert.equal(isRedisPersistenceEnabled(), false);
  const health = getRedisHealth();
  assert.equal(health.mode, "sqlite");
  assert.equal(health.configured, false);
  assert.equal(health.degraded, false);
});

test("account upsert propagates to another instance and applies cooldown", async () => {
  const prefix = unique("qpx-account");
  const pair = await makePair(prefix);
  const id = unique("acc");
  const until = Date.now() + 60_000;
  try {
    pair.writer.publish("account", "upsert", id, {
      id,
      email: `${id}@test.local`,
      password: "encrypted-blob",
      proxy: null,
      cooldown_until: until,
      cooldown_reason: "RateLimited",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await pair.writer.flush();
    await pair.reader.consumeOnce();

    const row = getDatabase()
      .prepare("SELECT email, password, cooldown_until FROM accounts WHERE id = ?")
      .get(id) as
      | { email: string; password: string; cooldown_until: number }
      | undefined;
    assert.ok(row, "remote account must be written to the local snapshot");
    assert.equal(row!.email, `${id}@test.local`);
    assert.equal(row!.password, "encrypted-blob");
    assert.equal(row!.cooldown_until, until);
    assert.ok(getAccountCooldownInfo(id)?.onCooldown);
  } finally {
    await stopPair(pair);
    getDatabase().prepare("DELETE FROM accounts WHERE id = ?").run(id);
  }
});

test("account delete propagates to another instance", async () => {
  const prefix = unique("qpx-account-del");
  const pair = await makePair(prefix);
  const id = unique("acc-del");
  try {
    getDatabase()
      .prepare("INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)")
      .run(id, `${id}@test.local`, "encrypted-blob");

    pair.writer.publish("account", "delete", id);
    await pair.writer.flush();
    await pair.reader.consumeOnce();

    const row = getDatabase()
      .prepare("SELECT id FROM accounts WHERE id = ?")
      .get(id);
    assert.equal(row, undefined);
  } finally {
    await stopPair(pair);
  }
});

test("logical session propagates across instances", async () => {
  const prefix = unique("qpx-session");
  const pair = await makePair(prefix);
  const sessionId = unique("session");
  try {
    pair.writer.publish("session", "upsert", sessionId, {
      accountId: "acc-remote",
      chatSessionId: "chat-remote",
      parentId: "parent-remote",
      instructionsSent: true,
      timestamp: Date.now(),
    });
    await pair.writer.flush();
    await pair.reader.consumeOnce();

    const state = getLogicalThreadState(sessionId);
    assert.ok(state);
    assert.equal(state!.accountId, "acc-remote");
    assert.equal(state!.chatSessionId, "chat-remote");
    assert.equal(state!.parentId, "parent-remote");
    assert.equal(state!.instructionsSent, true);
  } finally {
    await stopPair(pair);
    await import("../services/qwen-thread-state.ts").then((m) =>
      m.applyRemoteLogicalThreadDelete(sessionId),
    );
  }
});

test("daily usage deltas accumulate on the receiving instance", async () => {
  const prefix = unique("qpx-usage");
  const pair = await makePair(prefix);
  const accountId = unique("usage-acc");
  const dateUtc = getUtcDateString();
  try {
    pair.writer.publish("usage", "delta", `${accountId}:${dateUtc}`, {
      accountId,
      dateUtc,
      promptTokens: 10,
      completionTokens: 20,
      weightedTokens: 20,
      totalTokens: 30,
      turnsCount: 1,
    });
    pair.writer.publish("usage", "delta", `${accountId}:${dateUtc}`, {
      accountId,
      dateUtc,
      promptTokens: 5,
      completionTokens: 6,
      weightedTokens: 6,
      totalTokens: 11,
      turnsCount: 1,
    });
    await pair.writer.flush();
    await pair.reader.consumeOnce();

    const usage = getAccountDailyUsage(accountId, dateUtc);
    assert.equal(usage.promptTokens, 15);
    assert.equal(usage.completionTokens, 26);
    assert.equal(usage.weightedTokens, 26);
    assert.equal(usage.totalTokens, 41);
    assert.equal(usage.turnsCount, 2);
  } finally {
    await stopPair(pair);
    getDatabase()
      .prepare(
        "DELETE FROM account_daily_usage WHERE account_id = ? AND date_utc = ?",
      )
      .run(accountId, dateUtc);
  }
});

test("stored Responses API state propagates across instances", async () => {
  const prefix = unique("qpx-response");
  const pair = await makePair(prefix);
  const responseId = unique("resp");
  try {
    pair.writer.publish("response", "upsert", responseId, {
      responseJson: JSON.stringify({ id: responseId, object: "response" }),
      chatMessagesJson: JSON.stringify([
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ]),
      storedAt: Date.now(),
    });
    await pair.writer.flush();
    await pair.reader.consumeOnce();

    const history = getResponseHistory(responseId);
    assert.ok(history);
    assert.equal(history!.length, 2);
    assert.equal(history![0].content, "hello");
  } finally {
    await stopPair(pair);
    getDatabase()
      .prepare("DELETE FROM responses_store WHERE response_id = ?")
      .run(responseId);
  }
});

test("an empty Redis store is bootstrapped from the local snapshot", async () => {
  const prefix = unique("qpx-bootstrap");
  const transport = new MemoryRedisTransport();
  const id = unique("boot-acc");
  const email = `${id}@test.local`;
  try {
    getDatabase()
      .prepare("INSERT INTO accounts (id, email, password) VALUES (?, ?, ?)")
      .run(id, email, "encrypted-blob");

    const persistence = new RedisPersistence({
      transport,
      handlers: { apply: () => undefined },
      prefix,
      instanceId: "boot",
      pollIntervalMs: 25,
      snapshot: getLocalSnapshot,
    });
    await persistence.start();
    await persistence.flush();

    const raw = await transport.get(redisEntityKey(prefix, "account", id));
    assert.ok(raw, "the account should have been written to Redis");
    assert.equal(JSON.parse(raw!).email, email);
    await persistence.stop();
  } finally {
    getDatabase().prepare("DELETE FROM accounts WHERE id = ?").run(id);
  }
});

test("remote events do not echo back to their origin", async () => {
  const prefix = unique("qpx-origin");
  const transport = new MemoryRedisTransport();
  let applied = 0;
  const writer = new RedisPersistence({
    transport,
    handlers: {
      apply: () => {
        applied += 1;
      },
    },
    prefix,
    instanceId: "same",
    pollIntervalMs: 25,
  });
  try {
    await writer.start();
    writer.publish("user", "upsert", "user-1", { id: "user-1" });
    await writer.flush();
    await writer.consumeOnce();
    assert.equal(applied, 0);
  } finally {
    await writer.stop().catch(() => undefined);
  }
});
