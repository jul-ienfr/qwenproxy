# Contract: Externalized Context Cache

**Feature**: `013-externalized-context-cache`

The contract is internal (TypeScript module), not an HTTP surface. External HTTP
behavior of `/v1/chat/completions` is unchanged.

## Module: `src/services/externalized-context-cache.ts`

```ts
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

export class ExternalizedContextCache {
  constructor(options?: ExternalizedContextCacheOptions);

  lookup(
    accountId: string,
    variantHash: string,
    prompt: Buffer,
  ): CacheLookupResult | null;

  store(input: {
    accountId: string;
    variantHash: string;
    prompt: Buffer;
    filename: string;
    file: QwenFileEntry;
    now?: number;
  }): CachedUpload;

  invalidateEntry(id: string, reason: string): boolean;
  invalidateAccount(accountId: string, reason: string): number;
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;

  stats(): ExternalizedContextCacheStats;
  clear(): void;
}

export function getExternalizedContextCache(): ExternalizedContextCache;
export function computeExternalizedContextVariantHash(
  personalizationInstruction: string | null | undefined,
  proxyUrl: string | null | undefined,
): string;
export function hashUtf8Prefix(prompt: Buffer, byteLength: number): string;
export function sliceUtf8Tail(prompt: Buffer, byteLength: number): Buffer;
```

## Guarantees

- `lookup` returns `null` when the prompt is shorter than every candidate or no
  candidate digest matches.
- `lookup` prefers the candidate with the largest `byteLength`.
- `lookup` never returns an entry from another `accountId` or `variantHash`.
- `lookup` drops expired entries before matching.
- `store` keeps at most `maxEntries`, evicting the least-recently-used entry.
- `withLock` serializes tasks with the same key and propagates errors.
- No method stores or logs the prompt text.
- `stats()` returns monotonically increasing counters (except `entries`).

## Integration contract (`src/routes/chat/account.ts`)

- Cache is consulted only when `shouldExternalizeContext` is true and
  `config.qwen.externalizeContextCacheEnabled` is true.
- A hit is used only when `prompt.byteLength - prefixBytes <=
  config.qwen.externalizeLivePromptBytes`.
- A hit replaces the fresh-upload path and inlines the delta.
- A refresh/miss uploads once under `withLock(accountId + variantHash)`.
- `variantHash` covers the personalization/tool instruction and the account
  proxy.
- `dropFiles` retry invalidates the account's entries.
- Non-transient stream-creation failures on a cached attempt invalidate the used
  entry.
- Logs contain account email (masked), byte counts, file name and reason only.
