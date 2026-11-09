/**
 * Optional Redis-backed shared persistence.
 *
 * SQLite remains the local source of truth for synchronous reads and for
 * browser-adjacent state. In `DATA_SAVE_MODE=redis`, every shared mutation is
 * also written to Redis and appended to a Redis Stream; other instances tail the
 * stream, apply the event to their local SQLite snapshot and refresh their
 * in-memory caches. This keeps the existing synchronous call sites unchanged
 * while giving a bounded (default 1s) cross-instance propagation window.
 *
 * Shared domains: accounts + cooldowns, users, logical sessions, logical
 * thread parents, daily usage and stored Responses API state.
 * Local-only domains: Chromium/browser profiles, captured Qwen auth sessions,
 * personalization cache, server logs and the admin audit trail.
 */

import crypto from "node:crypto";
import { config } from "./config.ts";

export type RedisEntity =
  | "account"
  | "user"
  | "session"
  | "parent"
  | "usage"
  | "response";

export type RedisEventOp = "upsert" | "delete" | "delta" | "absolute";

export interface RedisPersistenceEvent {
  entity: RedisEntity;
  op: RedisEventOp;
  id: string;
  data?: unknown;
  origin: string;
  ts: number;
}

export interface RedisStreamMessage {
  id: string;
  message: Record<string, string>;
}

export interface RedisScanResult {
  cursor: string;
  keys: string[];
}

export interface RedisTransport {
  connect(): Promise<void>;
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hIncrBy(key: string, field: string, increment: number): Promise<number>;
  hIncrByFloat(
    key: string,
    field: string,
    increment: number,
  ): Promise<number>;
  xAdd(
    key: string,
    id: string,
    message: Record<string, string>,
  ): Promise<string>;
  xRead(
    streams: Array<{ key: string; id: string }>,
    options: { BLOCK?: number; COUNT?: number },
  ): Promise<Array<{ name: string; messages: RedisStreamMessage[] }> | null>;
  xRevRange(
    key: string,
    start: string,
    end: string,
    options?: { COUNT?: number },
  ): Promise<RedisStreamMessage[]>;
  scan(
    cursor: string,
    options: { MATCH?: string; COUNT?: number },
  ): Promise<RedisScanResult>;
  quit(): Promise<void>;
}

export interface RedisEventHandlers {
  apply(event: RedisPersistenceEvent): void;
}

export interface RedisLocalSnapshot {
  accounts: unknown[];
  users: unknown[];
  sessions: unknown[];
  parents: unknown[];
  usage: unknown[];
  responses: unknown[];
}

export interface RedisHealth {
  mode: "sqlite" | "redis";
  configured: boolean;
  required: boolean;
  connected: boolean;
  degraded: boolean;
  lastError: string | null;
  lastEventAt: number | null;
  lastPublishAt: number | null;
  pendingEvents: number;
  pendingWrites: number;
}

const STREAM_MAX_LEN = 10_000;
const IDLE_RETRY_MS = 2_000;

function entityPrefix(prefix: string, entity: RedisEntity): string {
  return `${prefix}:${entity}:`;
}

export function redisEntityKey(
  prefix: string,
  entity: RedisEntity,
  id: string,
): string {
  return `${entityPrefix(prefix, entity)}${id}`;
}

export function redisStreamKey(prefix: string): string {
  return `${prefix}:events`;
}

function parseEvent(message: Record<string, string>): RedisPersistenceEvent | null {
  const entity = message.e as RedisEntity | undefined;
  const op = message.o as RedisEventOp | undefined;
  const id = message.i;
  const origin = message.src || "unknown";
  const ts = Number(message.ts) || Date.now();
  if (!entity || !op || !id) return null;

  let data: unknown;
  if (message.d !== undefined && message.d !== "") {
    try {
      data = JSON.parse(message.d);
    } catch {
      return null;
    }
  }
  return { entity, op, id, data, origin, ts };
}

function serializeData(data: unknown): string | undefined {
  if (data === undefined) return undefined;
  try {
    return JSON.stringify(data);
  } catch {
    return undefined;
  }
}

/** Redis transport backed by the official `redis` client (loaded lazily). */
export class NodeRedisTransport implements RedisTransport {
  private client: any = null;
  private subscriber: any = null;
  private readonly url: string;
  private readonly connectTimeoutMs: number;

  constructor(url: string, connectTimeoutMs: number) {
    this.url = url;
    this.connectTimeoutMs = connectTimeoutMs;
  }

  async connect(): Promise<void> {
    const { createClient } = await import("redis");
    const makeClient = () => {
      const client = createClient({
        url: this.url,
        socket: {
          connectTimeout: this.connectTimeoutMs,
          reconnectStrategy: (retries: number) =>
            Math.min(1_000 * 2 ** Math.min(retries, 4), 15_000),
        },
      });
      client.on("error", () => {
        // Errors are surfaced through health(); unhandled 'error' events would
        // otherwise crash the process.
      });
      return client;
    };
    this.client = makeClient();
    // Blocking XREAD must not share the command connection, otherwise it
    // stalls every other Redis command for the duration of the block.
    this.subscriber = makeClient();
    await Promise.all([this.client.connect(), this.subscriber.connect()]);
  }

  async ping(): Promise<string> {
    return String(await this.client.ping());
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string): Promise<unknown> {
    return this.client.set(key, value);
  }

  async del(key: string): Promise<unknown> {
    return this.client.del(key);
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    return this.client.hGetAll(key);
  }

  async hIncrBy(
    key: string,
    field: string,
    increment: number,
  ): Promise<number> {
    return Number(await this.client.hIncrBy(key, field, increment));
  }

  async hIncrByFloat(
    key: string,
    field: string,
    increment: number,
  ): Promise<number> {
    return Number(await this.client.hIncrByFloat(key, field, increment));
  }

  async xAdd(
    key: string,
    id: string,
    message: Record<string, string>,
  ): Promise<string> {
    return String(
      await this.client.xAdd(key, id, message, {
        TRIM: {
          strategy: "MAXLEN",
          strategyModifier: "~",
          threshold: STREAM_MAX_LEN,
        },
      }),
    );
  }

  async xRead(
    streams: Array<{ key: string; id: string }>,
    options: { BLOCK?: number; COUNT?: number },
  ): Promise<Array<{ name: string; messages: RedisStreamMessage[] }> | null> {
    const result = await this.subscriber.xRead(streams, options);
    if (!result) return null;
    return result.map((stream: any) => ({
      name: String(stream.name),
      messages: (stream.messages || []).map((entry: any) => ({
        id: String(entry.id),
        message: entry.message || {},
      })),
    }));
  }

  async xRevRange(
    key: string,
    start: string,
    end: string,
    options?: { COUNT?: number },
  ): Promise<RedisStreamMessage[]> {
    const result = await this.client.xRevRange(key, start, end, options || {});
    return (result || []).map((entry: any) => ({
      id: String(entry.id),
      message: entry.message || {},
    }));
  }

  async scan(
    cursor: string,
    options: { MATCH?: string; COUNT?: number },
  ): Promise<RedisScanResult> {
    const result = await this.client.scan(cursor, options);
    return {
      cursor: String(result.cursor),
      keys: (result.keys || []).map(String),
    };
  }

  async quit(): Promise<void> {
    const clients = [this.client, this.subscriber];
    this.client = null;
    this.subscriber = null;
    await Promise.all(
      clients.map(async (client) => {
        if (!client) return;
        try {
          await client.quit();
        } catch {
          client.disconnect?.();
        }
      }),
    );
  }
}

/**
 * In-memory transport used by tests. It implements the small command surface
 * the persistence layer needs, including a stream with monotonic ids.
 */
export class MemoryRedisTransport implements RedisTransport {
  private values = new Map<string, string>();
  private hashes = new Map<string, Map<string, number>>();
  private streams = new Map<string, RedisStreamMessage[]>();
  private sequence = 0;

  async connect(): Promise<void> {}
  async ping(): Promise<string> {
    return "PONG";
  }
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<unknown> {
    this.values.set(key, value);
    return "OK";
  }
  async del(key: string): Promise<unknown> {
    const existed = this.values.delete(key) || this.hashes.delete(key);
    return existed ? 1 : 0;
  }
  async hGetAll(key: string): Promise<Record<string, string>> {
    const hash = this.hashes.get(key);
    if (!hash) return {};
    return Object.fromEntries([...hash].map(([field, value]) => [field, String(value)]));
  }
  async hIncrBy(
    key: string,
    field: string,
    increment: number,
  ): Promise<number> {
    const hash = this.hashes.get(key) || new Map<string, number>();
    const next = (hash.get(field) || 0) + increment;
    hash.set(field, next);
    this.hashes.set(key, hash);
    return next;
  }

  async hIncrByFloat(
    key: string,
    field: string,
    increment: number,
  ): Promise<number> {
    return this.hIncrBy(key, field, increment);
  }
  async xAdd(
    key: string,
    _id: string,
    message: Record<string, string>,
  ): Promise<string> {
    this.sequence += 1;
    const id = `${Date.now()}-${this.sequence}`;
    const entries = this.streams.get(key) || [];
    entries.push({ id, message: { ...message } });
    if (entries.length > STREAM_MAX_LEN) {
      entries.splice(0, entries.length - STREAM_MAX_LEN);
    }
    this.streams.set(key, entries);
    return id;
  }
  async xRead(
    streams: Array<{ key: string; id: string }>,
    options: { BLOCK?: number; COUNT?: number },
  ): Promise<Array<{ name: string; messages: RedisStreamMessage[] }> | null> {
    const output: Array<{ name: string; messages: RedisStreamMessage[] }> = [];
    for (const stream of streams) {
      const entries = this.streams.get(stream.key) || [];
      const limit = options.COUNT || entries.length;
      const messages = entries
        .filter((entry) => compareStreamIds(entry.id, stream.id) > 0)
        .slice(0, limit);
      if (messages.length > 0) {
        output.push({ name: stream.key, messages });
      }
    }
    const block = options.BLOCK;
    if (output.length === 0 && block) {
      // Emulate a blocking XREAD so the consumer loop does not busy-spin.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(block, 50)),
      );
    }
    return output.length > 0 ? output : null;
  }
  async xRevRange(
    key: string,
    _start: string,
    _end: string,
    options?: { COUNT?: number },
  ): Promise<RedisStreamMessage[]> {
    const entries = [...(this.streams.get(key) || [])].reverse();
    return entries.slice(0, options?.COUNT || entries.length);
  }
  async scan(
    cursor: string,
    options: { MATCH?: string; COUNT?: number },
  ): Promise<RedisScanResult> {
    const all = [...this.values.keys(), ...this.hashes.keys()];
    const match = options.MATCH;
    const regex = match
      ? new RegExp(`^${match.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`)
      : null;
    const filtered = regex ? all.filter((key) => regex.test(key)) : all;
    const start = Number(cursor) || 0;
    const count = options.COUNT || 100;
    const page = filtered.slice(start, start + count);
    const next = start + page.length >= filtered.length ? "0" : String(start + page.length);
    return { cursor: next, keys: page };
  }
  async quit(): Promise<void> {
    this.values.clear();
    this.hashes.clear();
    this.streams.clear();
  }

  /** Test helper: current raw value for a key. */
  peek(key: string): string | null {
    return this.values.get(key) ?? null;
  }
}

function compareStreamIds(a: string, b: string): number {
  if (a === b) return 0;
  const [aMs, aSeq] = a.split("-");
  const [bMs, bSeq] = b.split("-");
  const msDiff = Number(aMs) - Number(bMs);
  if (msDiff !== 0) return msDiff;
  return Number(aSeq || 0) - Number(bSeq || 0);
}

export class RedisPersistence {
  private readonly transport: RedisTransport;
  private readonly handlers: RedisEventHandlers;
  private readonly prefix: string;
  private readonly instanceId: string;
  private readonly pollIntervalMs: number;
  private readonly snapshot?: () => RedisLocalSnapshot;

  private running = false;
  private applyingRemote = false;
  private lastStreamId = "0-0";
  private consumerPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  private pendingEvents = 0;

  private status: RedisHealth = {
    mode: config.persistence.mode,
    configured: Boolean(config.persistence.redis.url),
    required: config.persistence.redis.required,
    connected: false,
    degraded: false,
    lastError: null,
    lastEventAt: null,
    lastPublishAt: null,
    pendingEvents: 0,
    pendingWrites: 0,
  };

  constructor(options: {
    transport: RedisTransport;
    handlers: RedisEventHandlers;
    prefix?: string;
    instanceId?: string;
    pollIntervalMs?: number;
    snapshot?: () => RedisLocalSnapshot;
  }) {
    this.transport = options.transport;
    this.handlers = options.handlers;
    this.prefix = options.prefix || config.persistence.redis.prefix;
    this.instanceId = options.instanceId || crypto.randomUUID();
    this.pollIntervalMs =
      options.pollIntervalMs || config.persistence.redis.syncIntervalMs;
    this.snapshot = options.snapshot;
  }

  get instanceIdentity(): string {
    return this.instanceId;
  }

  getHealth(): RedisHealth {
    return {
      ...this.status,
      pendingEvents: this.pendingEvents,
      pendingWrites: this.pendingWrites,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.transport.connect();
    await this.transport.ping();
    this.status.connected = true;
    this.status.degraded = false;

    await this.hydrate();
    if (this.snapshot) {
      await this.bootstrapIfEmpty();
    }

    const latest = await this.transport.xRevRange(
      redisStreamKey(this.prefix),
      "+",
      "-",
      { COUNT: 1 },
    );
    this.lastStreamId = latest[0]?.id || "0-0";

    this.running = true;
    this.consumerPromise = this.consumeLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.race([
      this.writeQueue.catch(() => undefined),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref?.();
      }),
    ]);
    if (this.consumerPromise) {
      await Promise.race([
        this.consumerPromise.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs + 500)),
      ]);
      this.consumerPromise = null;
    }
    try {
      await this.transport.quit();
    } catch {
      // Best-effort shutdown.
    }
    this.status.connected = false;
  }

  publish(
    entity: RedisEntity,
    op: RedisEventOp,
    id: string,
    data?: unknown,
  ): void {
    if (!this.running) return;
    const event: RedisPersistenceEvent = {
      entity,
      op,
      id,
      data,
      origin: this.instanceId,
      ts: Date.now(),
    };
    this.pendingEvents += 1;
    this.writeQueue = this.writeQueue
      .then(() => this.writeEvent(event))
      .catch((error) => {
        this.status.lastError =
          error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.pendingEvents = Math.max(0, this.pendingEvents - 1);
      });
  }

  /** Wait for queued publishes to finish (test/migration helper). */
  async flush(): Promise<void> {
    await this.writeQueue.catch(() => undefined);
  }

  /** Apply one event locally. Exposed for deterministic tests. */
  applyRemote(event: RedisPersistenceEvent): void {
    if (event.origin === this.instanceId) return;
    this.applyingRemote = true;
    try {
      this.handlers.apply(event);
      this.status.lastEventAt = Date.now();
    } catch (error) {
      this.status.lastError =
        error instanceof Error ? error.message : String(error);
    } finally {
      this.applyingRemote = false;
    }
  }

  /** Read and apply the next batch of remote events (test helper). */
  async consumeOnce(): Promise<number> {
    const batch = await this.transport.xRead(
      [{ key: redisStreamKey(this.prefix), id: this.lastStreamId }],
      { COUNT: 100 },
    );
    if (!batch) return 0;
    let applied = 0;
    for (const stream of batch) {
      for (const entry of stream.messages) {
        this.lastStreamId = entry.id;
        const event = parseEvent(entry.message);
        if (!event) continue;
        this.applyRemote(event);
        applied += 1;
      }
    }
    return applied;
  }

  private async consumeLoop(): Promise<void> {
    while (this.running) {
      try {
        const batch = await this.transport.xRead(
          [{ key: redisStreamKey(this.prefix), id: this.lastStreamId }],
          { BLOCK: this.pollIntervalMs, COUNT: 100 },
        );
        if (!batch) continue;
        for (const stream of batch) {
          for (const entry of stream.messages) {
            this.lastStreamId = entry.id;
            const event = parseEvent(entry.message);
            if (event) this.applyRemote(event);
          }
        }
        this.status.connected = true;
        this.status.degraded = false;
        this.status.lastError = null;
      } catch (error) {
        this.status.connected = false;
        this.status.degraded = true;
        this.status.lastError =
          error instanceof Error ? error.message : String(error);
        if (!this.running) return;
        await new Promise((resolve) => setTimeout(resolve, IDLE_RETRY_MS));
      }
    }
  }

  private async writeEvent(event: RedisPersistenceEvent): Promise<void> {
    this.pendingWrites += 1;
    try {
      if (event.entity === "usage") {
        const usage = event.data as {
          accountId?: string;
          dateUtc?: string;
          promptTokens?: number;
          completionTokens?: number;
          weightedTokens?: number;
          totalTokens?: number;
          turnsCount?: number;
        };
        if (event.op === "delete") {
          await this.transport.del(
            redisEntityKey(this.prefix, "usage", event.id),
          );
        } else {
          const key = redisEntityKey(this.prefix, "usage", event.id);
          const multiply = event.op === "delta" ? 1 : 0;
          const apply = async (field: string, value: number) => {
            // weightedTokens is fractional; HINCRBY only accepts integers.
            const incr =
              field === "weighted"
                ? this.transport.hIncrByFloat.bind(this.transport)
                : this.transport.hIncrBy.bind(this.transport);
            if (multiply === 1) {
              if (value !== 0) {
                await incr(key, field, value);
              }
            } else {
              const current = Number(
                (await this.transport.hGetAll(key))[field] || 0,
              );
              const delta = value - current;
              if (delta !== 0) {
                await incr(key, field, delta);
              }
            }
          };
          await apply("prompt", Number(usage.promptTokens) || 0);
          await apply("completion", Number(usage.completionTokens) || 0);
          await apply("weighted", Number(usage.weightedTokens) || 0);
          await apply("total", Number(usage.totalTokens) || 0);
          await apply("turns", Number(usage.turnsCount) || 0);
        }
      } else {
        const key = redisEntityKey(this.prefix, event.entity, event.id);
        if (event.op === "delete") {
          await this.transport.del(key);
        } else {
          const serialized = serializeData(event.data);
          if (serialized !== undefined) {
            await this.transport.set(key, serialized);
          }
        }
      }

      const message: Record<string, string> = {
        e: event.entity,
        o: event.op,
        i: event.id,
        src: event.origin,
        ts: String(event.ts),
      };
      const serialized = serializeData(event.data);
      if (serialized !== undefined) message.d = serialized;
      await this.transport.xAdd(redisStreamKey(this.prefix), "*", message);
      this.status.lastPublishAt = Date.now();
      this.status.connected = true;
      this.status.degraded = false;
      this.status.lastError = null;
    } finally {
      this.pendingWrites = Math.max(0, this.pendingWrites - 1);
    }
  }

  private async hydrate(): Promise<void> {
    await this.hydrateEntity("account", async (key, id) => {
      const raw = await this.transport.get(key);
      if (!raw) return null;
      return { entity: "account", op: "upsert", id, data: JSON.parse(raw) };
    });
    await this.hydrateEntity("user", async (key, id) => {
      const raw = await this.transport.get(key);
      if (!raw) return null;
      return { entity: "user", op: "upsert", id, data: JSON.parse(raw) };
    });
    await this.hydrateEntity("session", async (key, id) => {
      const raw = await this.transport.get(key);
      if (!raw) return null;
      return { entity: "session", op: "upsert", id, data: JSON.parse(raw) };
    });
    await this.hydrateEntity("parent", async (key, id) => {
      const raw = await this.transport.get(key);
      if (!raw) return null;
      return { entity: "parent", op: "upsert", id, data: JSON.parse(raw) };
    });
    await this.hydrateEntity("response", async (key, id) => {
      const raw = await this.transport.get(key);
      if (!raw) return null;
      return { entity: "response", op: "upsert", id, data: JSON.parse(raw) };
    });
    await this.hydrateEntity("usage", async (key, id) => {
      const hash = await this.transport.hGetAll(key);
      if (!hash || Object.keys(hash).length === 0) return null;
      const split = id.lastIndexOf(":");
      return {
        entity: "usage",
        op: "absolute",
        id,
        data: {
          accountId: split >= 0 ? id.slice(0, split) : id,
          dateUtc: split >= 0 ? id.slice(split + 1) : "",
          promptTokens: Number(hash.prompt) || 0,
          completionTokens: Number(hash.completion) || 0,
          weightedTokens: Number(hash.weighted) || 0,
          totalTokens: Number(hash.total) || 0,
          turnsCount: Number(hash.turns) || 0,
        },
      };
    });
  }

  private async hydrateEntity(
    entity: RedisEntity,
    load: (
      key: string,
      id: string,
    ) => Promise<Omit<RedisPersistenceEvent, "origin" | "ts"> | null>,
  ): Promise<void> {
    let cursor = "0";
    do {
      const page = await this.transport.scan(cursor, {
        MATCH: `${entityPrefix(this.prefix, entity)}*`,
        COUNT: 200,
      });
      cursor = page.cursor;
      for (const key of page.keys) {
        const id = key.slice(entityPrefix(this.prefix, entity).length);
        let event: Omit<RedisPersistenceEvent, "origin" | "ts"> | null = null;
        try {
          event = await load(key, id);
        } catch {
          // Skip a corrupted row instead of failing the whole hydration.
          continue;
        }
        if (event) {
          this.applyingRemote = true;
          try {
            this.handlers.apply({
              ...event,
              origin: "redis-hydrate",
              ts: Date.now(),
            });
          } catch (error) {
            // One malformed/conflicting row must not block startup hydration.
            this.status.lastError =
              error instanceof Error ? error.message : String(error);
          } finally {
            this.applyingRemote = false;
          }
        }
      }
    } while (cursor !== "0");
  }

  private async bootstrapIfEmpty(): Promise<void> {
    const page = await this.transport.scan("0", {
      MATCH: `${entityPrefix(this.prefix, "account")}*`,
      COUNT: 1,
    });
    if (page.keys.length > 0) return;
    const snapshot = this.snapshot?.();
    if (!snapshot) return;

    for (const account of snapshot.accounts) {
      const id = String((account as any).id || "");
      if (id) {
        await this.writeEvent({
          entity: "account",
          op: "upsert",
          id,
          data: account,
          origin: this.instanceId,
          ts: Date.now(),
        });
      }
    }
    for (const user of snapshot.users) {
      const id = String((user as any).id || "");
      if (id) {
        await this.writeEvent({
          entity: "user",
          op: "upsert",
          id,
          data: user,
          origin: this.instanceId,
          ts: Date.now(),
        });
      }
    }
    for (const session of snapshot.sessions) {
      const id = String((session as any).session_id || "");
      if (id) {
        await this.writeEvent({
          entity: "session",
          op: "upsert",
          id,
          data: {
            accountId: (session as any).account_id,
            chatSessionId: (session as any).chat_session_id,
            parentId: (session as any).parent_id ?? null,
            instructionsSent: Boolean((session as any).instructions_sent),
            timestamp:
              Date.parse((session as any).updated_at) ||
              Number((session as any).timestamp) ||
              Date.now(),
          },
          origin: this.instanceId,
          ts: Date.now(),
        });
      }
    }
    for (const parent of snapshot.parents) {
      const id = String((parent as any).chat_session_id || "");
      if (id) {
        await this.writeEvent({
          entity: "parent",
          op: "upsert",
          id,
          data: {
            accountId: (parent as any).accountId,
            parentId: (parent as any).parentId ?? null,
            timestamp: Number((parent as any).timestamp) || Date.now(),
          },
          origin: this.instanceId,
          ts: Date.now(),
        });
      }
    }
    for (const usage of snapshot.usage) {
      const account = String((usage as any).account_id || "");
      const date = String((usage as any).date_utc || "");
      if (!account || !date) continue;
      await this.writeEvent({
        entity: "usage",
        op: "absolute",
        id: `${account}:${date}`,
        data: {
          accountId: account,
          dateUtc: date,
          promptTokens: Number((usage as any).prompt_tokens) || 0,
          completionTokens: Number((usage as any).completion_tokens) || 0,
          weightedTokens: Number((usage as any).weighted_tokens) || 0,
          totalTokens: Number((usage as any).total_tokens) || 0,
          turnsCount: Number((usage as any).turns_count) || 0,
        },
        origin: this.instanceId,
        ts: Date.now(),
      });
    }
    for (const response of snapshot.responses) {
      const id = String((response as any).response_id || "");
      if (id) {
        await this.writeEvent({
          entity: "response",
          op: "upsert",
          id,
          data: {
            responseJson: (response as any).response_json,
            chatMessagesJson: (response as any).chat_messages_json,
            storedAt: (response as any).stored_at,
          },
          origin: this.instanceId,
          ts: Date.now(),
        });
      }
    }
  }
}

/**
 * One-shot migration: push the local SQLite snapshot into Redis if the shared
 * store is empty. Safe to run repeatedly; existing Redis data is left intact.
 */
export async function migrateLocalSnapshotToRedis(
  snapshot: RedisLocalSnapshot,
): Promise<RedisHealth> {
  const { url, prefix, connectTimeoutMs } = config.persistence.redis;
  if (!url) {
    throw new Error(
      "REDIS_URL is required to migrate local state (set DATA_SAVE_MODE=redis and REDIS_URL)",
    );
  }
  const transport = new NodeRedisTransport(url, connectTimeoutMs);
  const persistence = new RedisPersistence({
    transport,
    handlers: { apply: () => undefined },
    prefix,
    snapshot: () => snapshot,
  });
  try {
    await persistence.start();
    return persistence.getHealth();
  } finally {
    await persistence.stop().catch(() => undefined);
  }
}

let activePersistence: RedisPersistence | null = null;
let initPromise: Promise<void> | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

export function isRedisPersistenceEnabled(): boolean {
  return config.persistence.mode === "redis";
}

/** Publish a local mutation to Redis. No-op in SQLite mode. */
export function publishRedisEvent(
  entity: RedisEntity,
  op: RedisEventOp,
  id: string,
  data?: unknown,
): void {
  if (!isRedisPersistenceEnabled()) return;
  activePersistence?.publish(entity, op, id, data);
}

export function isApplyingRemoteRedisEvent(): boolean {
  return activePersistence !== null && (activePersistence as any).applyingRemote;
}

export async function initRedisPersistence(options: {
  handlers: RedisEventHandlers;
  snapshot?: () => RedisLocalSnapshot;
}): Promise<void> {
  if (!isRedisPersistenceEnabled()) return;
  if (initPromise) return initPromise;
  shuttingDown = false;

  initPromise = (async () => {
    const { url, prefix, required, syncIntervalMs, connectTimeoutMs } =
      config.persistence.redis;
    if (!url) {
      if (required) {
        throw new Error(
          "[Redis] DATA_SAVE_MODE=redis requires REDIS_URL (or set REDIS_REQUIRED=false to fall back to SQLite)",
        );
      }
      console.warn(
        "⚠️  [Redis] DATA_SAVE_MODE=redis without REDIS_URL; continuing with local SQLite only",
      );
      return;
    }

    const attempt = async () => {
      const transport = new NodeRedisTransport(url, connectTimeoutMs);
      const persistence = new RedisPersistence({
        transport,
        handlers: options.handlers,
        prefix,
        pollIntervalMs: syncIntervalMs,
        snapshot: options.snapshot,
      });
      try {
        await persistence.start();
      } catch (error) {
        // Release any partially connected client before the retry loop.
        await persistence.stop().catch(() => undefined);
        throw error;
      }
      activePersistence = persistence;
      const health = persistence.getHealth();
      console.log(
        `🔗 [Redis] Shared persistence connected (${health.pendingWrites} pending writes)`,
      );
    };

    try {
      await attempt();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (required) {
        throw new Error(
          `[Redis] Shared persistence is required but unavailable: ${message}`,
        );
      }
      console.warn(
        `⚠️  [Redis] Unavailable (${message}); continuing with local SQLite. Will retry in 5s.`,
      );
      scheduleRetry(attempt);
    }
  })();

  return initPromise;
}

function scheduleRetry(attempt: () => Promise<void>): void {
  if (retryTimer || shuttingDown) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (shuttingDown) return;
    attempt()
      .then(() => {
        console.log("🔗 [Redis] Shared persistence reconnected");
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`⚠️  [Redis] Retry failed: ${message}`);
        scheduleRetry(attempt);
      });
  }, 5_000);
  retryTimer.unref?.();
}

export async function shutdownRedisPersistence(): Promise<void> {
  shuttingDown = true;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  const persistence = activePersistence;
  activePersistence = null;
  initPromise = null;
  if (persistence) {
    await persistence.stop();
  }
}

export function getRedisHealth(): RedisHealth {
  if (!isRedisPersistenceEnabled()) {
    return {
      mode: "sqlite",
      configured: false,
      required: false,
      connected: false,
      degraded: false,
      lastError: null,
      lastEventAt: null,
      lastPublishAt: null,
      pendingEvents: 0,
      pendingWrites: 0,
    };
  }
  if (activePersistence) return activePersistence.getHealth();
  return {
    mode: "redis",
    configured: Boolean(config.persistence.redis.url),
    required: config.persistence.redis.required,
    connected: false,
    degraded: true,
    lastError: "not connected",
    lastEventAt: null,
    lastPublishAt: null,
    pendingEvents: 0,
    pendingWrites: 0,
  };
}

/**
 * Best-effort synchronous session prefetch used before a chat turn reads the
 * logical thread state. Redis is fast, but the read is still async because the
 * whole app is otherwise synchronous; the event stream normally applies the
 * state within one second, and this closes the immediate-continuation gap.
 */
export async function prefetchRedisSession(sessionId: string): Promise<void> {
  if (!isRedisPersistenceEnabled() || !sessionId || !activePersistence) return;
  const transport = (activePersistence as any).transport as RedisTransport;
  const prefix = (activePersistence as any).prefix as string;
  try {
    const raw = await transport.get(
      redisEntityKey(prefix, "session", sessionId),
    );
    if (!raw) return;
    activePersistence.applyRemote({
      entity: "session",
      op: "upsert",
      id: sessionId,
      data: JSON.parse(raw),
      origin: "redis-prefetch",
      ts: Date.now(),
    });
  } catch {
    // Fall back to the local snapshot; the stream consumer will catch up.
  }
}
