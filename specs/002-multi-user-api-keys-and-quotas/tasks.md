# Tasks: Multi-User API Keys and Quotas

**Feature**: `002-multi-user-api-keys-and-quotas`
**Plan**: [plan.md](plan.md)
**Spec**: [spec.md](spec.md)

## Phase 1 — Foundation

- [x] T001 Add the `users` table and indexes in `src/core/database.ts`.
- [x] T002 Add `src/core/users.ts`: key generation, SHA-256 hashing, prefix,
  create/list/get/update/revoke/rotate, `USER_API_KEYS` seeding.
- [x] T003 Add `src/core/user-quota.ts`: sliding-window RPM, acquire/release
  stream slots, `withUserStreamSlot` response wrapper.
- [x] T004 Add `USER_API_KEYS`, `USER_RATE_LIMIT_RPM`, `USER_MAX_CONCURRENCY`
  to `src/core/config.ts` and `.env.example`.
- [x] T005 Add tests for key generation/hash/verify, env seeding, RPM and
  concurrency, including double release.

## Phase 2 — Authentication

- [x] T006 Replace the single-key `verifyApiKey` with an `authenticateRequest`
  that resolves legacy local/global admin or a DB user, sets the Hono context
  identity and returns 401 on invalid/revoked keys.
- [x] T007 Keep the no-key loopback behavior and the legacy `API_KEY` admin
  behavior unchanged.
- [x] T008 Add `requireAdmin` middleware for `/admin/api/*`.

## Phase 3 — Quotas

- [x] T009 In `chatCompletions`, check RPM before parsing/account selection and
  return 429 with `Retry-After`.
- [x] T010 Acquire a user stream slot before account work; wrap streaming
  responses so the slot releases on done/error/cancel exactly once.
- [x] T011 Release the slot immediately for non-streaming responses.
- [x] T012 Apply RPM checks to `/v1/completions`, upload, images and videos.
- [x] T013 Record request, error and active-stream counters per user for the
  admin API/dashboard.

## Phase 4 — Management

- [x] T014 Add `src/api/admin-users.ts` with list/create/update/rotate/revoke.
- [x] T015 Mount `/admin/api/users` and protect it with `requireAdmin`.
- [x] T016 Add `src/cli/users.ts` and the `users` npm script.
- [x] T017 Update README and `.env.example` with auth, quotas and key handling.
- [ ] T018 Add a TUI hint or status line showing per-user quota configuration
  where the TUI already exposes server settings. Deferred to spec 003 (web
  dashboard): the CLI and admin API already expose all quota state, and the TUI
  has no per-user management screen in this slice.

## Phase 5 — Verification

- [x] T019 `npm run typecheck`.
- [x] T020 Unit tests for users/quota.
- [x] T021 Live: create a user with RPM 2 and concurrency 1; send 3 rapid
  requests and 2 overlapping streams; verify 429/no upstream work.
- [x] T022 Live: rotate and revoke; verify old key 401 and new key works.
- [x] T023 Verify legacy `API_KEY` and no-key loopback still work.

## Dependencies

- T001/T002 before T006/T014/T016.
- T003 before T009/T010.
- T006 before T009.
- T014 before T015.
- T021–T023 after server restart.

## Out of scope

- Token/cost quota enforcement (this slice tracks request/stream quotas).
- Shared quota state across multiple instances (depends on spec 008 Redis).
- Web dashboard UI (spec 003).
