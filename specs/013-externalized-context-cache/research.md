# Research: Externalized Context Cache and Prefix Reuse

**Feature**: `013-externalized-context-cache`

## Decisions

### 1. What to store

**Decision**: Store only `accountId`, `variantHash`, `contentHash` (SHA-256 of
the uploaded UTF-8 bytes), `byteLength`, the `QwenFileEntry`, the filename,
timestamps and counters. Never store the prompt text.

**Rationale**: Prefix matching does not need the text. Hashing the first
`byteLength` bytes of the incoming prompt and comparing digests is exact, keeps
memory bounded to metadata, and satisfies FR-010 (no conversation content in
cache telemetry). A 64-entry cache costs a few tens of kilobytes.

**Alternatives considered**:
- Store full prefix strings for `startsWith`: simplest to write but unbounded
  memory and unnecessary content retention. Rejected.
- Store a rolling hash of all prefix lengths: needs an index per length and
  still requires hashing the candidate slice. Rejected as premature.

### 2. Prefix key and match semantics

**Decision**: Key an entry by `accountId + variantHash + contentHash`; find a hit
by scanning the account's entries and checking
`sha256(prompt[0..entry.byteLength]) === entry.contentHash`. Prefer the longest
matching prefix. Reject a hit when the remaining delta exceeds
`externalizeLivePromptBytes`.

**Rationale**: Turn N+1's full history starts with turn N's full history. The
longest-prefix rule maximizes reuse, and the delta cap forces periodic
re-uploads so the inline prompt never has to drop middle context.

### 3. Variant fingerprint

**Decision**: `variantHash = sha256(personalizationInstruction ?? "" + "\0" +
maskedProxyUrl ?? "")`.

**Rationale**: Specs 001/002 deliver system instructions and tools through the
account-level personalization, not the conversation text. A change in tools or
system instructions must invalidate reuse even when the conversation prefix is
unchanged. The proxy participates because the edge case list requires
invalidating uploads tied to an old egress. `loadAccounts()` already returns a
masked proxy; the mask keeps the host/port/user and changes when the proxy is
edited.

### 4. Single-flight

**Decision**: Serialize uploads per `accountId + variantHash` with a promise
chain. Inside the lock, re-run `lookup` before uploading.

**Rationale**: Two concurrent turns can race. A global per-key lock is cheap.
The re-check lets the second request reuse a prefix the first just uploaded,
even when the exact prompts differ.

### 5. Upstream expiry and invalidation

**Decision**: Invalidate entries in two cases:
1. The retry layer sets `dropFiles` for `invalid_input`/attachment failures —
   invalidate the account's cached entries so the retry uploads a fresh file.
2. A stream-creation failure occurs on an attempt that reused a cached file and
   the retry is not a known transient (busy, quota, anti-bot, auth or
   network/timeout) — drop that entry so the next request re-uploads.

**Rationale**: A stale Qwen file id is only detectable through the upstream
response. Conservative invalidation trades a little hit rate for correctness.

### 6. TTL and LRU defaults

**Decision**: `TTL=3600s`, `MAX_ENTRIES=64`, both configurable; entries expire
lazily on lookup and store, and the least-recently-used entry is evicted when
the map exceeds the cap.

**Rationale**: The spec requires bounded memory without a background timer. One
hour matches typical agent sessions; a larger deployment can raise or lower it.

### 7. Disabled modes

**Decision**: `QWEN_EXTERNALIZE_CACHE_ENABLED=false`, or the existing
`QWEN_EXTERNALIZE_CONTEXT_ENABLED=false`, bypasses the cache with the legacy
upload-every-turn behavior.

**Rationale**: FR-009. The flag is a kill switch; the legacy path is the
fallback, not a corruption risk.

### 8. Observation

**Decision**: Add `externalized_context.cache.{hit,miss,refresh,eviction,
ttl_expired,upload,invalidation,failed,entries,reused_bytes}` to the metrics
registry and log one line per decision with account email, byte counts and file
name only.

**Rationale**: FR-008. Existing generic `cache.*` series are used by the
memory cache; dedicated names avoid mixing semantics.
