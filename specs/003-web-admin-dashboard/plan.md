# Implementation Plan: Authenticated Web Administration Dashboard

**Branch**: `003-web-admin-dashboard` | **Date**: 2026-11-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-web-admin-dashboard/spec.md`

## Summary

Serve a dependency-free administration dashboard from the existing Hono
process at `/admin`. Browsers authenticate with an API key once and receive a
signed, HttpOnly session cookie; cookie-authenticated mutations require a CSRF
token. The dashboard exposes an overview with live SSE updates (polling
fallback), account operations, user/key management, allowlisted settings, the
model catalog and redacted logs. Every mutation is recorded in a durable audit
table. The terminal UI remains unchanged.

## Technical Context

**Language/Version**: TypeScript 6.0 on Node.js 22+ (Node 24 in the current
environment)

**Primary Dependencies**: Hono 4, better-sqlite3 13, existing proxy core; no
frontend framework, no bundler, no new runtime dependency

**Storage**: SQLite `data/db/qwenproxy.db` plus a new `admin_audit` table. The
HMAC session secret is persisted at `data/db/.admin_session_secret` with mode
`0600`.

**Testing**: `node:test` via tsx; unit tests for session signing/expiry/CSRF,
dashboard auth (bearer, cookie, loopback), account masking/mutations, settings
allowlist and log redaction; typecheck gate.

**Target Platform**: Windows and Linux, Docker-compatible

**Project Type**: Single TypeScript service with TUI and HTTP API

**Performance Goals**: Overview snapshots are derived from in-memory state and
one indexed SQLite read per account; SSE pushes every 2s. No upstream call is
needed to render the dashboard.

**Constraints**: Must not break spec 001/002 semantics (legacy `API_KEY`,
loopback no-auth, revoked `sk-qpx-` keys, quota 429s); no credential in the
browser or in API JSON; single process; static assets embedded in the bundle.

**Scale/Scope**: Up to hundreds of accounts and users; a handful of concurrent
admin sessions.

## Constitution Check

- **Upstream compatibility**: `/v1/*` behavior and credentials are untouched;
  the shared identity resolver is extracted without changing precedence. PASS.
- **Browser-transport fidelity**: the dashboard only reads proxy state and
  triggers existing account operations; it does not bypass the browser
  transport. PASS.
- **Account isolation**: account mutations reuse the existing account manager
  and per-account mutexes. PASS.
- **Spec-driven**: plan, research, data model, contract, quickstart and tasks
  accompany the spec. PASS.
- **Observability**: overview KPIs, structured log stream and audit records are
  exposed; redaction is applied to everything browser-facing. PASS.
- **Tests**: session, auth, settings, account and redaction coverage plus the
  existing user/admin suite and typecheck gate. PASS.
- **Security**: HttpOnly signed cookie, SameSite=Strict, CSRF token, origin
  check, CSP, no secrets in storage/JSON/logs. PASS.
- **Simplicity**: vanilla HTML/CSS/JS strings served by Hono; one audit table;
  no build step. PASS.

## Project Structure

```text
src/
├── core/
│   ├── auth-identity.ts      # shared credential resolution (extracted)
│   ├── admin-session.ts      # HMAC session cookie create/verify
│   ├── admin-audit.ts        # admin_audit insert/list
│   ├── overview-stats.ts     # sliding 60s request/error windows
│   ├── database.ts           # admin_audit migration
│   └── users.ts              # existing user model (spec 002)
├── admin/
│   ├── app.ts                # dashboard router, session, overview, SSE
│   ├── auth.ts               # bearer/session/CSRF authentication
│   ├── accounts-api.ts       # account add/remove/cooldown/refresh/proxy
│   ├── overview.ts           # KPI and account snapshots
│   ├── settings.ts           # allowlisted settings descriptors
│   ├── logs.ts               # redaction for browser log views
│   └── ui.ts                 # embedded HTML/CSS/JS
├── api/
│   ├── server.ts             # mounts /admin and /admin/api/* auth
│   ├── admin-users.ts        # user CRUD + audit
│   └── models.ts             # exports loadModelsWithVariants
└── tests/
    ├── admin-session.test.ts
    ├── admin-dashboard.test.ts
    ├── admin-accounts.test.ts
    └── admin-settings.test.ts

package.json                  # existing scripts (no new dependency)
.env.example                  # session/auth notes
README.md                     # dashboard usage
```

## Phase 0 — Research

See `research.md`.

- Session transport: Hono 4.13.9 ships no cookie helper in this install, so a
  compact HMAC-SHA256 `base64url(JSON).signature` token is implemented locally.
- Identity reuse: the auth precedence in `server.ts` is extracted to
  `core/auth-identity.ts` so login and `/v1` cannot drift.
- Session secret: generated once, persisted next to the SQLite database; a
  restart keeps sessions valid without an env secret.
- CSRF: the session payload contains a random token; cookie-authenticated
  mutations must echo it in `x-csrf-token`. Bearer clients are exempt because
  they do not rely on ambient cookies.
- Live updates: a single SSE endpoint pushes an overview snapshot every 2s and
  forwards redacted log lines; the UI falls back to 5s polling on error.
- UI stack: static strings in `ui.ts`; no React build, no CDN, CSP `self` only.

## Phase 1 — Design

### Architecture

```text
Browser ──GET /admin──────────────► embedded HTML/CSS/JS
        ──POST /admin/api/session─► resolveIdentity → signed cookie (qpx_admin)
        ──GET  /admin/api/*───────► cookie/bearer → admin role → JSON
        ──GET  /admin/api/events──► SSE overview + redacted logs
        ──POST /admin/api/*───────► cookie + x-csrf-token → mutation + audit
```

`/admin/api/*` is protected by one middleware that skips only
`/admin/api/session`. The dashboard router handles UI, session, overview,
accounts, settings, models, logs, audit and SSE. `admin-users.ts` keeps serving
`/admin/api/users` and adds audit records.

### Data model

See `data-model.md`. One new table (`admin_audit`); sessions are stateless
signed cookies; settings are allowlisted descriptors over existing config.

### Authentication and CSRF

1. `POST /admin/api/session` accepts `{ apiKey }` and resolves it with the same
   rules as `/v1` (legacy key, DB key, loopback no-key). Non-admin identities
   are rejected with 403.
2. On success the server sets `qpx_admin` with `HttpOnly; SameSite=Strict;
   Path=/admin; Max-Age=28800` and adds `Secure` when the request is HTTPS or
   `X-Forwarded-Proto: https`.
3. Responses return the CSRF token and expiry. The UI keeps the CSRF token in
   memory only.
4. `authenticateAdminRequest` accepts bearer/x-api-key without CSRF, or a
   session cookie. Cookie mutations require a matching `Origin` (when present)
   and `x-csrf-token`.
5. When no credential is supplied and no `API_KEY` is configured, the historical
   loopback local-admin behavior is preserved.

### Settings allowlist

`chat_mode`, `global_proxy_url`, `chat_request_log`, `rate_limit_requests`,
`rate_limit_tokens`, `user_default_rpm`, `user_default_concurrency`. Writes are
hot-applied in memory and persisted to `.env`; unknown keys are rejected.

### Secret handling

- Account list responses show masked emails and masked proxy URLs; passwords are
  never returned.
- Log views pass through `redactLogText` (API keys, bearer tokens, JWTs,
  password/token assignments, proxy credentials).
- Audit details never contain API keys or passwords.

## Phase 2 — Verification

- `npm run typecheck`.
- `admin-session.test.ts`: sign/verify, tamper, expiry, CSRF.
- `admin-dashboard.test.ts`: login/logout, cookie gate, CSRF, role enforcement,
  loopback fallback, overview and SSE.
- `admin-accounts.test.ts`: masking, add/proxy/cooldown/delete, audit.
- `admin-settings.test.ts`: allowlist, coercion, unknown key rejection.
- Existing `user-auth`, `user-quota`, `users`, `local-auth`, metrics and CORS
  tests.
- Live run: restart the proxy, log in, confirm KPIs, trigger a cooldown, edit a
  proxy, rotate a user key, change a setting, watch SSE and logs.

## Complexity Tracking

No constitution violations. Adds one table, four core modules, one router tree,
embedded static assets and four test files. No dependency or build-step change.
