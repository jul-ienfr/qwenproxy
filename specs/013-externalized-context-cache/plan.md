# Implementation Plan: Externalized Context Cache and Prefix Reuse

**Branch**: `013-externalized-context-cache` | **Date**: 2026-11-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/013-externalized-context-cache/spec.md`

## Summary

Cache the Qwen text attachment produced by large-context externalization so a
follow-up agent turn can reuse the previously uploaded file when its history
starts with the cached prefix. Entries are keyed by account id, a
personalization/tool fingerprint and a prefix content hash; the cache keeps only
hashes and file metadata, never conversation text. On a hit the inline prompt
carries only the delta since the cached prefix. A per-account single-flight
lock prevents duplicate concurrent uploads. TTL and LRU bounds protect memory.
Fresh uploads replace the entry when the delta grows past the live-prompt
budget, when the history diverges, or when an upstream attachment failure is
observed.

## Technical Context

**Language/Version**: TypeScript 6.0 on Node.js 22+ (Node 24 in the current
environment)

**Primary Dependencies**: existing proxy core only (`node:crypto`, `node:buffer`);
no new runtime dependency

**Storage**: in-memory `Map`; no schema change. Optional Redis sharing belongs
to spec 008.

**Testing**: `node:test` via tsx; unit tests for prefix matching, isolation,
TTL, LRU, single-flight and stats; typecheck gate.

**Target Platform**: Windows and Linux, Docker-compatible

**Project Type**: Single TypeScript service with TUI and HTTP API

**Performance Goals**: A cache hit avoids one OSS STS call and one multipart
upload (100–300 KB) per agent turn. Lookup hashes at most the candidate prefix
bytes for the account's entries (bounded by `MAX_ENTRIES`).

**Constraints**: No conversation text stored or logged; no cross-account reuse;
must be a no-op when externalization is disabled; must not weaken the existing
externalization fallback.

**Scale/Scope**: Up to `MAX_ENTRIES` cached uploads per process (default 64),
each a few hundred bytes of metadata.

## Constitution Check

- **Upstream compatibility**: only the existing externalization path changes;
  inline prompts keep the same shape. PASS.
- **Browser-transport fidelity**: uploads still go through the existing
  `uploadTextAsQwenFile` path with the account's browser headers. PASS.
- **Account isolation**: entries are keyed by account id; failover always
  performs a per-account lookup. PASS.
- **Spec-driven**: plan, research, data model, contract, quickstart and tasks
  accompany the spec. PASS.
- **Observability**: dedicated metrics and structured logs for hit, miss,
  refresh, eviction, TTL expiry and invalidation; no content. PASS.
- **Tests**: unit coverage plus the existing mock suite and typecheck gate. PASS.
- **Security**: only SHA-256 digests, byte counts and Qwen file metadata are
  retained. PASS.
- **Simplicity**: one focused module plus a small integration block; no new
  dependency or table. PASS.

## Project Structure

```text
src/
├── services/
│   └── externalized-context-cache.ts   # module: lookup, store, lock, stats
├── core/
│   ├── config.ts                       # QWEN_EXTERNALIZE_CACHE_* keys
│   └── metrics.ts                      # externalized_context.cache.* series
├── routes/chat/
│   └── account.ts                      # integration in the externalization block
└── tests/
    └── externalized-context-cache.test.ts
specs/013-externalized-context-cache/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── tasks.md
└── contracts/externalized-context-cache.md
```

## Integration Points

1. `buildExternalizedInlinePrompt` (account.ts) stays for fresh uploads.
2. New `buildReusedContextInlinePrompt` renders the delta after a cached prefix.
3. The externalization block (account.ts ~667–716) becomes:
   - compute `variantHash` from the personalization instruction and proxy;
   - `cache.lookup(accountId, variantHash, promptBuffer)`;
   - on a hit with a delta within `externalizeLivePromptBytes`, reuse the entry;
   - otherwise, inside `cache.withLock`, re-check then upload and
     `cache.store(...)`.
4. Track whether the attempt used a cached entry; invalidate it when the retry
   layer drops attachments for `invalid_input`.
5. Config: `QWEN_EXTERNALIZE_CACHE_ENABLED` (default `true`),
   `QWEN_EXTERNALIZE_CACHE_TTL_SECONDS` (default `3600`),
   `QWEN_EXTERNALIZE_CACHE_MAX_ENTRIES` (default `64`).

## Phases

- Phase 1 — cache module and config.
- Phase 2 — metrics and account.ts integration.
- Phase 3 — tests (module + retry integration) and docs.
- Phase 4 — verification: typecheck, targeted tests, full mock suite.

## Complexity Tracking

No constitution violations. The only added complexity is the cache module and a
second inline-prompt builder, both bounded and unit-tested.
