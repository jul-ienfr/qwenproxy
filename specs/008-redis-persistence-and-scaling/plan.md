# Implementation Plan: Redis Persistence and Multi-Instance Scaling

**Feature Branch**: `008-redis-persistence-and-scaling`

**Status**: Implemented

**Spec**: `specs/008-redis-persistence-and-scaling/spec.md`

## Chosen Scope

The first release shares the full serializable state needed to continue a
conversation on another instance:

- accounts and cooldowns;
- users and API-key metadata;
- logical sessions (logical id -> account, upstream chat, parent);
- per-chat parent state;
- daily usage counters;
- stored Responses API state.

It deliberately keeps the following local to each instance:

- Chromium/Patchright browser profiles;
- captured Qwen auth sessions and cookies;
- personalization cache;
- server logs;
- admin audit trail.

This resolves the spec assumption in favour of sharing sessions, not only
accounts/users/cooldowns.

## Architecture

- **SQLite remains the synchronous local source of truth.** Every existing call
  site keeps reading and writing SQLite synchronously; no call site became
  async except `buildFinalContext`, which already was.
- **Redis mirrors shared mutations.** In `DATA_SAVE_MODE=redis`, publish hooks
  next to each local write push the same change to Redis and append an event to
  the `qpx:events` Stream.
- **Cross-instance propagation.** Each instance tails the Stream on a separate
  subscriber connection (blocking `XREAD`), applies remote events to its local
  SQLite snapshot, and refreshes in-memory caches. The default propagation
  window is 1 second (`REDIS_SYNC_INTERVAL_MS`).
- **Immediate session continuation.** `buildFinalContext` prefetches the
  session key directly before reading the local thread state, closing the gap
  for a request that lands on instance B immediately after being created on A.
- **Self-events are ignored.** Each event carries a random instance id; an
  instance never re-applies its own mutation.
- **Bootstrap.** On startup, entity keys are hydrated first. If the shared
  account namespace is empty, the local SQLite snapshot seeds Redis, so an
  operator can switch an existing deployment without a separate step.
- **Outage handling.** Redis failures are caught and reported through
  `GET /health` (`persistence.connected=false`, `degraded=true`,
  `lastError`). Traffic continues on local SQLite. With `REDIS_REQUIRED=true`
  startup fails with an explicit error instead of silently diverging.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATA_SAVE_MODE` | `sqlite` | `sqlite` or `redis` |
| `REDIS_URL` | empty | Required when mode is `redis` |
| `REDIS_PREFIX` | `qpx` | Key/stream namespace |
| `REDIS_REQUIRED` | `false` | Fail startup when Redis is unavailable |
| `REDIS_SYNC_INTERVAL_MS` | `1000` | Stream propagation window |
| `REDIS_CONNECT_TIMEOUT_MS` | `5000` | Initial connection timeout |

All Redis imports are dynamic, so SQLite-only installations never load the
`redis` package and need no Redis dependency at runtime.

## Encryption and Key Management

Accounts are published as the raw encrypted SQLite row (AES-256-GCM). Redis never
receives plaintext passwords or proxy credentials. Every instance must share the
same `ENCRYPTION_KEY` (or the same `data/db/.encryption_key` file) so rows
written by one node decrypt on another. This is documented in `.env.example`
and `docker-compose.redis.yml`.

## TTL and Eviction Policy

- Sessions keep the existing 24-hour inactivity TTL. Both SQLite and Redis
  entities are refreshed on each turn, so active sessions never expire.
- Responses API state keeps the existing 7-day TTL logic.
- Daily usage is keyed by UTC date and is naturally superseded every day.
- The event Stream is trimmed approximately at 10,000 entries; it is a
  notification channel, not the durable store.
- Operators should disable `allkeys-lru` eviction for the `qpx:*` namespace or
  use a dedicated Redis database. Because SQLite remains authoritative, an
  evicted key is recoverable from a running instance or the next bootstrap.

## Migration

```bash
DATA_SAVE_MODE=redis REDIS_URL=redis://host:6379 npm run redis:migrate
```

The command snapshots SQLite and writes entities only when the shared account
namespace is empty. It touches Redis only; the SQLite source is never modified.

## Files

- `src/core/redis-store.ts` - transport, event stream, hydration, health,
  migration entry point.
- `src/core/redis-sync.ts` - remote-apply handlers and local snapshot.
- `src/services/qwen-thread-state.ts` - session/parent publish and remote apply.
- `src/core/accounts.ts`, `src/core/users.ts`, `src/core/daily-usage.ts`,
  `src/routes/responses/state.ts` - publish hooks.
- `src/core/account-manager.ts` - remote cooldown application.
- `src/routes/chat/context.ts` - session prefetch.
- `src/api/server.ts` - startup/shutdown wiring and `/health` status.
- `src/cli/redis-migrate.ts` - migration CLI.
- `docker-compose.redis.yml` - two-instance example.

## Verification

- Focused suite: `src/tests/redis-persistence.test.ts` (8 tests) uses
  `MemoryRedisTransport` to prove account/cooldown, session, usage and Responses
  propagation, bootstrap, and self-event suppression.
- Full `npm run test:mock` exercises the SQLite-only path unchanged.
- `npm run typecheck` and `npm run build` must pass.
