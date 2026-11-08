import crypto from "node:crypto";

import { config } from "../core/config.ts";
import { metrics } from "../core/metrics.js";
import type { QwenFileEntry } from "../routes/upload.ts";

/**
 * In-memory cache of Qwen text attachments produced by large-context
 * externalization. An agent turn that extends a previously uploaded history
 * reuses the same upstream file instead of re-uploading 100–300 KB.
 *
 * Only digests and file metadata are retained: the prompt text is never stored
 * or logged. Entries are keyed by account, a personalization/tool fingerprint
 * and the upload content hash, and are matched by hashing the corresponding
 * prefix of the incoming prompt (exact prefix test, not a `startsWith` on text).
 */

export interface ExternalizedContextCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export interface CachedUpload {
  id: string;
  accountId: string;
  variantHash: string;
  contentHash: string;
  byteLength: number;
  filename: string;
  file: QwenFileEntry;
  createdAt: number;
  lastUsedAt: number;
  hits: number;
}

export interface CacheLookupResult {
  entry: CachedUpload;
  /** Bytes of the incoming prompt already covered by the upload. */
  prefixBytes: number;
}

export interface ExternalizedContextCacheStats {
  hits: number;
  misses: number;
  refreshes: number;
  evictions: number;
  ttlExpirations: number;
  uploads: number;
  invalidations: number;
  reusedBytes: number;
  entries: number;
}

export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_CACHE_MAX_ENTRIES = 64;

export function sha256Hex(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Fingerprint everything that must invalidate reuse but is not part of the
 * conversation text: the personalization/tool instructions delivered at the
 * account level, and the outbound proxy (a changed egress may invalidate
 * files uploaded from the previous IP).
 */
export function computeExternalizedContextVariantHash(
  personalizationInstruction: string | null | undefined,
  proxyUrl: string | null | undefined,
): string {
  return sha256Hex(
    `${personalizationInstruction ?? ""}\u0000${proxyUrl ?? ""}`,
  );
}

/** SHA-256 of the first `byteLength` UTF-8 bytes of `prompt`. */
export function hashUtf8Prefix(prompt: Buffer, byteLength: number): string {
  const end = Math.max(0, Math.min(byteLength, prompt.length));
  return sha256Hex(prompt.subarray(0, end));
}

/**
 * Keep the last `maxBytes` bytes of a UTF-8 buffer without starting in the
 * middle of a multi-byte code point. Used to cap the inlined delta.
 */
export function sliceUtf8Tail(prompt: Buffer, maxBytes: number): Buffer {
  if (maxBytes <= 0) return Buffer.alloc(0);
  if (prompt.length <= maxBytes) return prompt;
  let start = prompt.length - maxBytes;
  while (start < prompt.length && (prompt[start] & 0xc0) === 0x80) start++;
  return prompt.subarray(start);
}

function entryId(
  accountId: string,
  variantHash: string,
  contentHash: string,
): string {
  return sha256Hex(
    `${accountId}\u0000${variantHash}\u0000${contentHash}`,
  ).slice(0, 16);
}

export class ExternalizedContextCache {
  private readonly entries = new Map<string, CachedUpload>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  private hits = 0;
  private misses = 0;
  private refreshes = 0;
  private evictions = 0;
  private ttlExpirations = 0;
  private uploads = 0;
  private invalidations = 0;
  private reusedBytes = 0;

  constructor(options: ExternalizedContextCacheOptions = {}) {
    this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_CACHE_TTL_MS);
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
  }

  /**
   * Find the longest cached upload whose content is a prefix of `prompt`,
   * without recording a hit. Expired entries are dropped before matching.
   * Callers that actually reuse the result must call `recordHit`.
   */
  peek(
    accountId: string,
    variantHash: string,
    prompt: Buffer,
  ): CacheLookupResult | null {
    const now = this.now();
    this.purgeExpired(now);

    let best: CachedUpload | null = null;
    for (const entry of this.entries.values()) {
      if (entry.accountId !== accountId) continue;
      if (entry.variantHash !== variantHash) continue;
      if (entry.byteLength > prompt.length) continue;
      if (best && entry.byteLength <= best.byteLength) continue;
      if (hashUtf8Prefix(prompt, entry.byteLength) !== entry.contentHash) {
        continue;
      }
      best = entry;
    }

    return best ? { entry: best, prefixBytes: best.byteLength } : null;
  }

  /**
   * Find a reusable prefix and record the hit. Convenience wrapper over
   * `peek` + `recordHit` for callers that reuse every match.
   */
  lookup(
    accountId: string,
    variantHash: string,
    prompt: Buffer,
  ): CacheLookupResult | null {
    const hit = this.peek(accountId, variantHash, prompt);
    if (!hit) {
      this.recordMiss();
      return null;
    }
    this.recordHit(hit.entry);
    return hit;
  }

  recordHit(entry: CachedUpload): void {
    const now = this.now();
    entry.lastUsedAt = now;
    entry.hits++;
    // Move to the hot end so LRU eviction keeps recently used entries.
    this.entries.delete(entry.id);
    this.entries.set(entry.id, entry);

    this.hits++;
    this.reusedBytes += entry.byteLength;
    metrics.increment("externalized_context.cache.hit");
    metrics.increment("externalized_context.cache.reused_bytes", entry.byteLength);
  }

  recordMiss(): void {
    this.misses++;
    metrics.increment("externalized_context.cache.miss");
  }

  /** Record a hit that was discarded because its delta was too large. */
  recordRefresh(): void {
    this.refreshes++;
    metrics.increment("externalized_context.cache.refresh");
  }

  store(input: {
    accountId: string;
    variantHash: string;
    prompt: Buffer;
    filename: string;
    file: QwenFileEntry;
    now?: number;
  }): CachedUpload {
    const now = input.now ?? this.now();
    this.purgeExpired(now);

    const contentHash = sha256Hex(input.prompt);
    const id = entryId(input.accountId, input.variantHash, contentHash);
    const existing = this.entries.get(id);
    const entry: CachedUpload = {
      id,
      accountId: input.accountId,
      variantHash: input.variantHash,
      contentHash,
      byteLength: input.prompt.length,
      filename: input.filename,
      file: input.file,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
      hits: existing?.hits ?? 0,
    };

    this.entries.delete(id);
    this.entries.set(id, entry);
    this.uploads++;
    metrics.increment("externalized_context.cache.upload");
    this.enforceMaxEntries(now);
    return entry;
  }

  invalidateEntry(id: string, _reason: string): boolean {
    const removed = this.entries.delete(id);
    if (removed) {
      this.invalidations++;
      metrics.increment("externalized_context.cache.invalidation");
      metrics.gauge("externalized_context.cache.entries", this.entries.size);
    }
    return removed;
  }

  invalidateAccount(accountId: string, _reason: string): number {
    let removed = 0;
    for (const [id, entry] of [...this.entries]) {
      if (entry.accountId !== accountId) continue;
      this.entries.delete(id);
      removed++;
    }
    if (removed > 0) {
      this.invalidations += removed;
      metrics.increment(
        "externalized_context.cache.invalidation",
        removed,
      );
      metrics.gauge("externalized_context.cache.entries", this.entries.size);
    }
    return removed;
  }

  invalidateVariant(
    accountId: string,
    variantHash: string,
    _reason: string,
  ): number {
    let removed = 0;
    for (const [id, entry] of [...this.entries]) {
      if (entry.accountId !== accountId) continue;
      if (entry.variantHash !== variantHash) continue;
      this.entries.delete(id);
      removed++;
    }
    if (removed > 0) {
      this.invalidations += removed;
      metrics.increment(
        "externalized_context.cache.invalidation",
        removed,
      );
      metrics.gauge("externalized_context.cache.entries", this.entries.size);
    }
    return removed;
  }

  /**
   * Serialize tasks sharing `key`. Used to prevent two concurrent turns from
   * uploading the same context. Errors propagate; the chain always releases.
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const guard = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, guard);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === guard) this.locks.delete(key);
    }
  }

  stats(): ExternalizedContextCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      refreshes: this.refreshes,
      evictions: this.evictions,
      ttlExpirations: this.ttlExpirations,
      uploads: this.uploads,
      invalidations: this.invalidations,
      reusedBytes: this.reusedBytes,
      entries: this.entries.size,
    };
  }

  clear(): void {
    this.entries.clear();
    this.locks.clear();
    metrics.gauge("externalized_context.cache.entries", 0);
  }

  private purgeExpired(now: number): void {
    let removed = 0;
    for (const [id, entry] of [...this.entries]) {
      if (now - entry.createdAt < this.ttlMs) continue;
      this.entries.delete(id);
      this.ttlExpirations++;
      removed++;
      metrics.increment("externalized_context.cache.ttl_expired");
    }
    if (removed > 0) {
      metrics.gauge("externalized_context.cache.entries", this.entries.size);
    }
  }

  private enforceMaxEntries(now: number): void {
    this.purgeExpired(now);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.evictions++;
      metrics.increment("externalized_context.cache.eviction");
    }
    metrics.gauge("externalized_context.cache.entries", this.entries.size);
  }
}

let singleton: ExternalizedContextCache | null = null;

export function getExternalizedContextCache(): ExternalizedContextCache {
  if (!singleton) {
    singleton = new ExternalizedContextCache({
      ttlMs: config.qwen.externalizeContextCacheTtlSeconds * 1000,
      maxEntries: config.qwen.externalizeContextCacheMaxEntries,
    });
  }
  return singleton;
}

/** Test hook: drop the process-wide cache so config changes take effect. */
export function resetExternalizedContextCacheForTests(): void {
  singleton = null;
}
