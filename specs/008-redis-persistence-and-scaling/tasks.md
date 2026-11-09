# Tasks: Redis Persistence and Multi-Instance Scaling

**Feature Branch**: `008-redis-persistence-and-scaling`

**Status**: Complete (T001-T032)

## Phase 1 - Configuration and Foundations

- [x] T001 Add `DATA_SAVE_MODE`, `REDIS_URL`, `REDIS_PREFIX`, `REDIS_REQUIRED`,
  `REDIS_SYNC_INTERVAL_MS` and `REDIS_CONNECT_TIMEOUT_MS` to the config schema.
- [x] T002 Expose the parsed `config.persistence` block with SQLite defaults.
- [x] T003 Install `redis@^5` as a production dependency and keep all imports
  dynamic.
- [x] T004 Add a `RedisTransport` abstraction with a real Node Redis client and a
  `MemoryRedisTransport` test backend.
- [x] T005 Use a dedicated subscriber connection for blocking `XREAD` so normal
  commands are never stalled.

## Phase 2 - Shared Store

- [x] T006 Define shared entities (`account`, `user`, `session`, `parent`,
  `usage`, `response`) and event operations (`upsert`, `delete`, `delta`,
  `absolute`).
- [x] T007 Implement the `qpx:events` Stream with approximate 10,000-entry
  trimming and per-instance origin ids.
- [x] T008 Implement startup hydration from entity keys before stream tailing.
- [x] T009 Implement empty-Redis bootstrap from the local SQLite snapshot.
- [x] T010 Implement `getRedisHealth()` with connected/degraded/error/pending
  counters.
- [x] T011 Implement graceful shutdown that drains queued publishes.
- [x] T012 Retry the initial connection every 5 seconds when Redis is optional
  and unavailable.

## Phase 3 - Remote Apply and Publish Hooks

- [x] T013 Create `redis-sync.ts` handlers for every shared entity.
- [x] T014 Publish account create/update/proxy/cooldown/delete rows as raw
  encrypted SQLite rows.
- [x] T015 Apply remote account rows and cooldown changes to SQLite plus the
  in-memory cooldown map.
- [x] T016 Publish and apply user create/update/rotate/revoke rows.
- [x] T017 Publish and apply logical session upserts and deletions.
- [x] T018 Publish and apply per-chat parent upserts and deletions.
- [x] T019 Publish daily usage deltas and apply them additively on receivers.
- [x] T020 Publish and apply stored Responses API state.
- [x] T021 Publish session/parent deletions when an account is removed or a chat
  is cleaned up.
- [x] T022 Prefetch the session key before `getLogicalThreadState` in
  `buildFinalContext`.

## Phase 4 - Server Integration

- [x] T023 Initialize Redis persistence before `loadAccounts()` in
  `startServer()`.
- [x] T024 Shut Redis down after the logical-thread flush and before
  `closeDatabase()`.
- [x] T025 Expose `persistence` in the authenticated `/health` response.
- [x] T026 Keep `/health` responsive while Redis is down and never crash the
  process on persistence errors.

## Phase 5 - Migration and Documentation

- [x] T027 Add `src/cli/redis-migrate.ts` and the `redis:migrate` npm script.
- [x] T028 Document shared vs local domains, encryption-key requirements, TTL
  policy and outage behaviour in the plan and `.env.example`.
- [x] T029 Add `docker-compose.redis.yml` with Redis plus two instances sharing
  one `ENCRYPTION_KEY`.
- [x] T030 Update the gap index and specs index to mark 008 implemented.

## Phase 6 - Verification

- [x] T031 Add `src/tests/redis-persistence.test.ts` covering account/cooldown,
  session, usage, Responses, bootstrap and origin suppression, and register it
  in both mock test scripts.
- [x] T032 Run typecheck, the focused suite, the full mock suite and the build.
