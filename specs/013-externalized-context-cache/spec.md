# Feature Specification: Externalized Context Cache and Prefix Reuse

**Feature Branch**: `013-externalized-context-cache`

**Created**: 2026-11-07

**Status**: Draft

**Input**: Gap analysis vs `Rfym21/Qwen2API`: `AGENT_CONTEXT_PREFIX_REUSE` reuses
the parsed history prefix across turns (`AGENT_CONTEXT_PREFIX_TTL_SECONDS`,
`AGENT_CONTEXT_PREFIX_MAX_ENTRIES`). The current project externalizes the full
history to a Qwen text attachment on every request, without reuse.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reuse an uploaded context across turns (Priority: P1)

A coding agent sends turn N and then turn N+1 with the same history prefix. The
proxy reuses the previously uploaded Qwen file instead of uploading the whole
history again.

**Why this priority**: Re-uploading a 100–300 KB history on every agent turn
costs latency, OSS calls and parse quota; Qwen may also rate-limit repeated
large uploads.

**Independent Test**: Send two consecutive requests whose second history starts
with the first; verify the second request reuses the same file id and does not
upload a new file.

**Acceptance Scenarios**:

1. **Given** a cached context for account A and a new turn whose history starts
   with the cached prefix, **When** the request runs, **Then** the cached file is
   attached and no new upload occurs.
2. **Given** a history that diverges from the cached prefix, **Then** a new file
   is uploaded and the cache entry is replaced.
3. **Given** a cached file older than the TTL, **Then** it is not reused and a
   fresh upload occurs.

---

### User Story 2 - Keep accounts isolated (Priority: P1)

A context uploaded for account A is never attached to a request routed to account
B unless B has its own valid upload.

**Why this priority**: Qwen file ids may be account-scoped; cross-account reuse
could fail or leak conversation data.

**Independent Test**: Build a cache on account A, force the next request to
account B, and verify B uploads its own file.

**Acceptance Scenarios**:

1. **Given** a cache entry keyed by account A, **When** the request fails over to
   B, **Then** B performs its own upload.
2. **Given** B reuses an entry, **Then** the entry is keyed by B's account id.

---

### User Story 3 - Bound memory and storage (Priority: P2)

An operator can configure the cache TTL and maximum entries; stale entries are
evicted without affecting correctness.

**Why this priority**: An unbounded cache in a long-running proxy is a memory
leak.

**Independent Test**: Set max entries to 2, create 3 contexts, and verify the
oldest is evicted.

**Acceptance Scenarios**:

1. **Given** `MAX_ENTRIES=2`, **When** a third context is uploaded, **Then** the
   least-recently-used entry is evicted.
2. **Given** `TTL=60s`, **When** an entry is older than 60s, **Then** it is not
   reused.
3. **Given** an upload failure, **Then** the request falls back to a fresh
   inline/file attempt and logs the failure.

### Edge Cases

- Two concurrent turns for the same account and prefix must not upload twice;
  use a single-flight lock.
- A cached file id expires upstream before the local TTL; the next request must
  detect the failure and re-upload.
- The history prefix may be identical while the system prompt/tools changed; the
  cache key must include the personalization/tool hash.
- Large-context externalization is disabled; the cache must not activate.
- The account proxy changed; cached uploads tied to the old IP should be
  invalidated.
- Restarting the process may drop the in-memory cache; persisted metadata is
  optional.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST cache externalized context uploads by account,
  content prefix hash and tool/personalization hash.
- **FR-002**: A request whose history starts with a cached prefix MUST reuse the
  cached Qwen file when the TTL is valid.
- **FR-003**: A divergent history MUST trigger a fresh upload and replace the
  entry.
- **FR-004**: Cache entries MUST be isolated per account.
- **FR-005**: The cache MUST support a configurable TTL and maximum entry count.
- **FR-006**: Concurrent requests for the same key MUST NOT upload the same
  context twice.
- **FR-007**: Expired or invalid upstream file ids MUST be detected and replaced.
- **FR-008**: Cache hits, misses, evictions and re-uploads MUST be observable in
  logs and metrics.
- **FR-009**: The cache MUST be disabled when large-context externalization is
  disabled.
- **FR-010**: No conversation content may be logged as part of cache telemetry.

### Key Entities

- **ContextCacheKey**: account id, prefix hash, tool/personalization hash.
- **CachedUpload**: Qwen file entry/id, bytes, created time, last used time.
- **CacheStats**: hits, misses, evictions, re-uploads, TTL expirations.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A repeated 200-message agent turn avoids a second OSS upload.
- **SC-002**: Account failover always produces a per-account upload.
- **SC-003**: Cache size never exceeds the configured maximum.
- **SC-004**: A stale file id is replaced within one request.
- **SC-005**: No cache key or log contains raw conversation text.

## Assumptions

- The current externalization path (spec added 2026-11-07) is the base.
- Cached file ids remain valid for the configured TTL; upstream expiry is
  detected by the existing error path.
- The cache may start in memory; Redis-backed sharing is optional and depends on
  spec 008.
- Prefix reuse is safe because Qwen attaches the full prefix and the inline
  prompt carries the new turn.
