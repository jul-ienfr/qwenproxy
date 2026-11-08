# Tasks: Externalized Context Cache and Prefix Reuse

**Feature**: `013-externalized-context-cache`
**Plan**: [plan.md](plan.md)
**Spec**: [spec.md](spec.md)

## Phase 1 â€” Cache module

- [x] T001 Add `src/services/externalized-context-cache.ts` with lookup/store,
  longest-prefix match, TTL, LRU, per-key single-flight, invalidation and stats.
- [x] T002 Add `computeExternalizedContextVariantHash` (personalization + masked
  proxy) and UTF-8 helpers (`hashUtf8Prefix`, `sliceUtf8Tail`).
- [x] T003 Add `QWEN_EXTERNALIZE_CACHE_ENABLED`, `..._TTL_SECONDS` and
  `..._MAX_ENTRIES` to `src/core/config.ts` (defaults true/3600/64).

## Phase 2 â€” Metrics and integration

- [x] T004 Register `externalized_context.cache.*` counters/gauge in
  `src/core/metrics.ts`.
- [x] T005 Wire the cache into the externalization block in
  `src/routes/chat/account.ts`: lookup, single-flight re-check, fresh upload,
  delta inline prompt.
- [x] T006 Add `buildReusedContextInlinePrompt` and track whether an attempt
  reused a cached entry.
- [x] T007 Invalidate on `dropFiles` retries and on non-transient failures of a
  cached attempt.
- [x] T008 Keep the legacy upload-every-turn path when the cache or
  externalization is disabled.

## Phase 3 â€” Tests and documentation

- [x] T009 Add `src/tests/externalized-context-cache.test.ts`: empty cache,
  prefix hit, divergent miss, longest-prefix preference, account isolation,
  variant isolation, TTL expiry, LRU eviction, single-flight, invalidation,
  stats, UTF-8 helpers, no text retention.
- [x] T010 Add the new suite to `npm run test:mock`.
- [x] T011 Update `README.md` (externalization/cache knobs and observability)
  and `docs/FEATURE-GAPS.md` status.
- [x] T012 Update `specs/README.md` status for spec 013.

## Phase 4 â€” Verification

- [x] T013 `npm run typecheck`.
- [x] T014 Run the focused cache suite.
- [x] T015 Run `npm run test:mock` (full).
- [x] T016 Live-verify prefix reuse with a large-context request (cache hit and
  no second upload).
- [x] T017 Commit and push.
