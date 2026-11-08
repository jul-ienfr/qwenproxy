# Data Model: Externalized Context Cache

**Feature**: `013-externalized-context-cache`

## Entities

### CachedUpload

One Qwen text attachment produced by externalization.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | `sha256(accountId + "\0" + variantHash + "\0" + contentHash)[0..16]`; stable per entry |
| `accountId` | `string` | Owning Qwen account; the isolation boundary |
| `variantHash` | `string` | SHA-256 of personalization/tool instruction + masked proxy |
| `contentHash` | `string` | SHA-256 of the uploaded UTF-8 payload |
| `byteLength` | `number` | UTF-8 byte length of the uploaded payload |
| `filename` | `string` | `qwenproxy-context-<ts>.txt` |
| `file` | `QwenFileEntry` | Upstream attachment descriptor (file id, url, size) |
| `createdAt` | `number` | Epoch ms |
| `lastUsedAt` | `number` | Epoch ms; LRU key |
| `hits` | `number` | Reuse count for this entry |

Invariants:

- `byteLength > 0`.
- `contentHash = sha256(payload)` where `payload` was exactly what was uploaded.
- An entry is valid only while `now - createdAt < ttlMs`.
- Entries are never matched across `accountId` or `variantHash`.

### ContextCacheKey (logical)

`(accountId, variantHash, contentHash)`.

Prefix reuse additionally requires that the incoming prompt's first
`entry.byteLength` bytes hash to `entry.contentHash`.

### CacheStats

| Counter | Meaning |
| --- | --- |
| `hits` | Lookups that returned a reusable entry |
| `misses` | Lookups with no matching prefix |
| `refreshes` | Hits rejected because the delta exceeded the live-prompt budget |
| `evictions` | Entries removed by LRU |
| `ttlExpirations` | Entries dropped because they were older than the TTL |
| `uploads` | Fresh Qwen uploads performed through the cache |
| `invalidations` | Entries dropped explicitly after an upstream failure |
| `reusedBytes` | Sum of `byteLength` for cache hits (upload bytes avoided) |
| `entries` | Current entry count (gauge) |

## Lifecycle

```text
lookup(accountId, variantHash, prompt)
  ├─ no candidate / no prefix match ─────────────► miss ─► upload ─► store
  ├─ match, delta ≤ live budget ──────────────────► hit  ─► attach + inline delta
  └─ match, delta > live budget ──────────────────► refresh ─► upload ─► store
store(entry)
  ├─ drop expired entries
  ├─ insert/replace by id
  └─ while size > maxEntries: evict least-recently-used
invalidate(accountId | entryId)
  └─ remove matching entries, increment invalidations
```

## Configuration

| Env key | Default | Meaning |
| --- | --- | --- |
| `QWEN_EXTERNALIZE_CACHE_ENABLED` | `true` | Master switch (no-op when externalization is off) |
| `QWEN_EXTERNALIZE_CACHE_TTL_SECONDS` | `3600` | Entry lifetime |
| `QWEN_EXTERNALIZE_CACHE_MAX_ENTRIES` | `64` | LRU bound |

## Metrics

`externalized_context.cache.hit`, `.miss`, `.refresh`, `.eviction`,
`.ttl_expired`, `.upload`, `.invalidation`, `.failed`, `.entries` (gauge),
`.reused_bytes` (counter).
