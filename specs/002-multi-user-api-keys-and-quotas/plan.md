# Implementation Plan: Multi-User API Keys and Quotas

**Branch**: `002-multi-user-api-keys-and-quotas` | **Date**: 2026-11-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-multi-user-api-keys-and-quotas/spec.md`

## Summary

Add SQLite-backed users with hashed API keys, admin/user roles, per-key RPM
limits and per-key concurrent stream limits. Keep the legacy `API_KEY` as a
bootstrap admin identity and keep the current no-auth loopback behavior. Enforce
quotas before any account selection, release stream slots on completion, error
or client cancellation, and expose management through a CLI plus a minimal
authenticated admin API that the future web dashboard can consume.

## Technical Context

**Language/Version**: TypeScript 6.0 on Node.js 22+ (Node 24 in the current
environment)

**Primary Dependencies**: Hono 4, better-sqlite3 13, Zod 4, tsx

**Storage**: SQLite `data/db/qwenproxy.db`; new `users` table; API keys stored as
SHA-256 hashes with a display prefix; no plaintext keys in the database

**Testing**: `node:test` via tsx; unit tests for key generation/hash/verification,
RPM window, concurrency acquire/release, env seeding; typecheck gate

**Target Platform**: Windows and Linux, Docker-compatible

**Project Type**: Single TypeScript service with TUI and HTTP API

**Performance Goals**: Auth lookup is one indexed SQLite read per request; quota
checks are in-memory O(1) and do not add browser/account work

**Constraints**: Existing `API_KEY` deployments must work unchanged; no plaintext
key at rest; no new runtime dependency; admin API must fail closed

**Scale/Scope**: Up to hundreds of users; tens of concurrent streams per process

## Constitution Check

- **Upstream compatibility**: existing `/v1/*` routes and legacy `API_KEY`
  behavior preserved. PASS.
- **Browser-transport fidelity**: quotas run before account/browser work and do
  not change the transport. PASS.
- **Account isolation**: user quotas are separate from account cooldowns; one
  user cannot consume another user's slot. PASS.
- **Spec-driven**: plan, research, data model, contract and tasks accompany the
  spec. PASS.
- **Observability**: 429 responses carry `Retry-After`; usage counters and audit
  records are exposed. PASS.
- **Tests**: key hashing/verification, RPM, concurrency and migration tests;
  typecheck gate. PASS.
- **Security**: keys hashed, admin routes require admin role, no key logging.
  PASS.
- **Simplicity**: one SQLite table, one in-memory limiter, no Redis dependency.
  PASS.

## Project Structure

```text
src/
├── core/
│   ├── users.ts             # schema CRUD, key generation/hash, env seeding
│   ├── user-quota.ts        # RPM window + concurrency slots
│   ├── database.ts          # users table migration
│   └── config.ts            # USER_API_KEYS, default RPM/concurrency
├── api/
│   ├── server.ts            # auth middleware, admin routes
│   └── admin-users.ts       # admin user endpoints (new)
├── cli/
│   └── users.ts             # list/create/revoke/rotate/limits
├── routes/chat/index.ts     # quota enforcement + stream release wrapper
└── tests/
    ├── users.test.ts
    └── user-quota.test.ts

package.json                 # "users" script
.env.example                 # USER_API_KEYS, defaults
README.md                    # auth and quota operations
```

## Phase 0 — Research

- Key hashing: SHA-256 is sufficient for high-entropy generated keys; store the
  hex digest plus a short prefix for display. Verification hashes the provided
  key and compares the digest. Legacy low-entropy `API_KEY` remains a constant
  time string comparison and is not stored in the users table.
- RPM window: sliding 60-second ring of timestamps per user; prune on each check.
  Admin identities bypass quotas; users with limit 0 are unlimited.
- Concurrency: in-memory active-stream counter per user; acquire before the chat
  handler does account work; release on stream close, error or cancel.
- Stream release: wrap the Response body in a `ReadableStream` that calls the
  release exactly once on `done`, `error` or `cancel`. Non-stream responses
  release immediately after the handler returns.
- Revocation: set `revoked_at`; authentication rejects revoked users. Keep the
  row for audit; rotation creates a new key hash on the same user.
- Admin API: resolved identity with role `admin`; legacy `API_KEY` is an admin.

## Phase 1 — Design

### Data model

See `data-model.md`. `users` is keyed by UUID, with unique `api_key_hash`, role,
RPM, concurrency, lifecycle timestamps.

### Management contract

See `contracts/users-cli.md` and `contracts/admin-users-api.md`.

### Enforcement points

1. `authenticateRequest` in `server.ts` resolves the identity and stores it on
   the Hono context.
2. `chatCompletions` calls `checkUserRequest` and `acquireUserStream` before
   `parseRequestBody`/account selection.
3. The response body is wrapped with `withUserStreamSlot` so streaming slots are
   released exactly once.
4. Non-chat routes check RPM only; uploads/images/videos use the same request
   limiter.

### Backward compatibility

- No API key configured + loopback → local admin identity, no quotas.
- Legacy `API_KEY` configured → global admin identity, no quotas.
- `USER_API_KEYS` seeds normal users at startup and on first auth.
- Existing clients without a key keep working on loopback.

## Complexity Tracking

No constitution violations. Adds one table, two core modules, one CLI, one admin
router and a response wrapper.
