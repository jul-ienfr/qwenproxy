# Research: Authenticated Web Administration Dashboard

**Feature**: `003-web-admin-dashboard`

## Decisions

### 1. Session transport

**Decision**: Stateless signed cookie `qpx_admin` containing
`base64url(JSON payload) + "." + HMAC-SHA256 signature`.

**Rationale**: The installed Hono 4.13.9 does not include the `hono/cookie`
helper (verified against `node_modules/hono/dist`). Implementing a compact local
codec avoids a new dependency, keeps sessions valid across restarts (secret is
persisted) and allows the session payload to carry the CSRF token.

**Payload**: `{ sub, label, role, csrf, iat, exp }`; `role` must be `admin` for
the session to be accepted. TTL is 8 hours.

**Cookie attributes**: `HttpOnly`, `SameSite=Strict`, `Path=/admin`,
`Max-Age=28800`, and `Secure` when the request is HTTPS or behind
`X-Forwarded-Proto: https`.

**Alternatives considered**:
- Server-side session table: more moving parts and a DB write per request;
  signed stateless cookies are sufficient because revocation is handled by
  rotating the signing secret / restarting.
- `localStorage` token: rejected by the spec (credentials in browser storage).

### 2. Identity resolution reuse

**Decision**: Extract the precedence from `server.ts` into
`src/core/auth-identity.ts` and call it from both `/v1` and the dashboard login.

**Rationale**: Two copies of the rule would drift and could weaken auth. The
resolver preserves spec 002 exactly: legacy `API_KEY` → DB key → loopback
no-key fallback; revoked `sk-qpx-` keys never fall back.

### 3. Admin authentication and CSRF

**Decision**: `authenticateAdminRequest` accepts:
- bearer/x-api-key (no CSRF; not cookie-based), or
- a valid session cookie, requiring `x-csrf-token` for POST/PUT/PATCH/DELETE and
  rejecting a mismatched `Origin` when present.

**Rationale**: Cookie auth is ambient, so mutations need CSRF protection.
Bearer clients (CLI, tests, scripts) cannot be CSRF'd and remain easy to use.
`SameSite=Strict` provides defence in depth.

### 4. Live updates

**Decision**: One SSE endpoint `/admin/api/events` sends an `overview` event
immediately and every 2 seconds, plus `log` events from the existing server log
stream. The browser uses `EventSource`; on error it closes the stream and polls
`/admin/api/overview` every 5 seconds, showing a "polling (degraded)" indicator.

**Rationale**: The proxy already maintains a log subscriber set; reusing it
avoids duplicate plumbing. Polling keeps the dashboard useful behind proxies
that buffer or block SSE.

### 5. UI stack

**Decision**: Dependency-free HTML/CSS/vanilla JS embedded as TypeScript strings
in `src/admin/ui.ts`.

**Rationale**: The project ships as a single tsx/esbuild bundle. A React build
would add a toolchain, a lockfile surface and a second artifact. The dashboard is
small enough for vanilla DOM code. All untrusted values are inserted with
`textContent`/`createElement`, never `innerHTML`, and CSP restricts sources to
`self`.

### 6. Overview KPIs

**Decision**: Derive KPIs from existing in-memory sources: `metrics`, the account
manager, `playwright` active IDs, `listUsers`, `getPoolDailyUsageSummary` and
`process.memoryUsage`. Add two process-local 60-second sliding windows for RPM
and errors.

**Rationale**: Cumulative counters cannot answer "requests per minute". The
windows are cheap arrays pruned on read and bounded to 20k samples. No upstream
call is made, so the dashboard works while Qwen is down.

### 7. Settings allowlist

**Decision**: A descriptor table in `src/admin/settings.ts` is the only source of
readable/writable keys. Writes mutate the live config object and persist to
`.env` through the existing `updateEnvVariable` helper.

**Rationale**: Prevents arbitrary environment mutation from the browser while
still removing the need to edit `.env` for routine changes. All seven current
entries are hot-applied; the descriptor includes a `restartRequired` flag for
future entries.

### 8. Audit

**Decision**: New `admin_audit` table (`actor`, `action`, `target`, `result`,
`details`, `created_at`) written by a fail-soft `recordAudit` helper.

**Rationale**: The spec requires an audit record per mutation. Writes must never
break the operation, so failures are logged and swallowed. Details are truncated
and never include credentials.

### 9. Log redaction

**Decision**: Redact API keys (`sk-...`), bearer tokens, JWTs, `password/token`
assignments and URL-embedded proxy credentials before logs reach the browser.

**Rationale**: The raw buffer is intentionally lossless for local debugging, but
the dashboard is a network surface. Redaction is applied to both the REST logs
endpoint and SSE `log` events.

## Open Questions Resolved

- **Where is the dashboard mounted?** `/admin`, with JSON under `/admin/api`.
  `/admin/api/users` remains owned by `admin-users.ts`.
- **What happens on non-loopback HTTP?** The UI shows a TLS warning; cookies omit
  `Secure` only because the transport is not encrypted. The spec treats
  non-loopback exposure as requiring TLS/tunnel.
- **Does the dashboard replace the TUI?** No; both read the same state.
