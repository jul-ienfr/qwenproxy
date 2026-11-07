# Contract: Admin Dashboard HTTP API

**Feature**: `003-web-admin-dashboard`

Base path: `/admin`. JSON error shape:

```json
{ "error": { "type": "authentication_error", "message": "..." } }
```

Types: `authentication_error` (401), `permission_error` (403),
`not_found_error` (404), `invalid_request_error` (400/429),
`server_error` (5xx).

## Authentication

Protected endpoints accept either:

- `Authorization: Bearer <api-key>` or `x-api-key: <api-key>`, or
- a valid `qpx_admin` session cookie. For `POST`/`PUT`/`PATCH`/`DELETE` with a
  cookie, `x-csrf-token` must match the token returned by the session endpoint.
  A mismatched `Origin`, when supplied, is rejected.

The admin role is required; a valid non-admin key receives 403.

The only unprotected route is `POST /admin/api/session`. `GET`/`DELETE` on it
self-validate the cookie.

On an install with no `API_KEY`, no session and no credentials, the historical
loopback local-admin behavior is preserved.

## Static UI

| Method | Path | Description |
| --- | --- | --- |
| GET | `/admin` | HTML dashboard (CSP, no-store) |
| GET | `/admin/assets/admin.css` | Stylesheet |
| GET | `/admin/assets/admin.js` | Client script |

## Session

### `POST /admin/api/session`

Request: `{ "apiKey": "sk-..." }` (empty string allowed on a no-key loopback
install).

Response `200`:

```json
{
  "user": { "id": "global-admin", "label": "API_KEY operator", "role": "admin" },
  "csrf": "base64url",
  "expiresAt": 1762500000000
}
```

Sets `qpx_admin=...; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=28800`
(with `Secure` over HTTPS). Errors: `401` invalid/missing key, `403` non-admin.

### `GET /admin/api/session`

Returns the same shape for a valid cookie, else `401`.

### `DELETE /admin/api/session`

Clears the cookie, records `session.logout` when a session exists, returns
`{ "success": true }`.

## Overview

### `GET /admin/api/overview`

Returns an `OverviewSnapshot` (see `data-model.md`).

### `GET /admin/api/events`

Server-Sent Events. Sends:

- `event: overview` immediately and every 2 seconds with an overview snapshot;
- `event: log` for each new server log line (redacted).

Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache,
no-transform`, `X-Accel-Buffering: no`.

## Accounts

### `GET /admin/api/accounts`

```json
{ "accounts": [ { "id": "...", "email": "jo***@example.com", "proxy": "http://***", "cooldown_until": 0, "cooldown_reason": null, "cooldown_remaining_ms": 0, "headers_ready": true, "active": false } ] }
```

### `POST /admin/api/accounts`

Body: `{ "email": "...", "password": "...", "proxy": "http://..." | null }`.
Returns `201 { "account": AccountSnapshot }`. Errors: `400` validation/duplicate.

### `DELETE /admin/api/accounts/:id`

Removes the account, its browser profile and sessions. `404` when unknown.
Returns `{ "success": true }`.

### `PATCH /admin/api/accounts/:id/proxy`

Body: `{ "proxy": "http://user:pass@host:port" | null }`. `null`/empty means
direct. Returns `{ "account": AccountSnapshot }`.

### `POST /admin/api/accounts/:id/cooldown/clear`

Clears one account cooldown. Returns `{ "success": true, "account": ... }`.

### `POST /admin/api/accounts/cooldowns/clear`

Clears every active cooldown. Returns `{ "success": true, "cleared": n }`.

### `POST /admin/api/accounts/:id/headers/refresh`

Forces a header/session refresh. Returns `{ "success": true, "account": ... }`;
`502` when the refresh fails.

All account mutations write an audit record.

## Users

Owned by `src/api/admin-users.ts`; see
`specs/002-multi-user-api-keys-and-quotas/contracts/admin-users-api.md` for the
payloads. Paths:

| Method | Path | Description |
| --- | --- | --- |
| GET | `/admin/api/users` | List users (with `active_streams`) |
| POST | `/admin/api/users` | Create user; returns key exactly once |
| PATCH | `/admin/api/users/:id` | Update RPM/concurrency |
| POST | `/admin/api/users/:id/rotate` | Rotate key; returns key once |
| DELETE | `/admin/api/users/:id` | Revoke key |

All mutations write an audit record (`user.create`, `user.limits.update`,
`user.key.rotate`, `user.revoke`). The API key is never included in audit data.

## Settings

### `GET /admin/api/settings`

```json
{ "settings": [ { "key": "chat_mode", "label": "Chat mode", "group": "Runtime", "type": "select", "value": "thread", "options": ["thread", "thread-temp", "stateless", "stateless-temp"], "restartRequired": false, "help": "..." } ] }
```

### `PUT /admin/api/settings`

Body: `{ "values": { "rate_limit_requests": 1000, "chat_mode": "stateless" } }`.

Values are hot-applied and persisted to `.env`. Unknown keys, wrong types or
invalid proxy URLs return `400`. Returns `{ "settings": [...] }`.

## Models

### `GET /admin/api/models`

```json
{ "accountId": "uuid-or-undefined", "models": [ { "id": "...", "name": "...", "context_window": 131072, "capabilities": { "...": true } } ] }
```

Uses the live catalog when an account is ready and the cached/fallback catalog
otherwise. `502` only when the catalog cannot be produced at all.

## Logs and Audit

### `GET /admin/api/logs?level=all|info|warn|error&limit=200`

Returns `{ "logs": [ { "time": "HH:MM:SS", "level": "INFO", "message": "..." } ] }`
with secrets redacted. `limit` is clamped to 1..1000.

### `GET /admin/api/audit?limit=100`

Returns `{ "records": [ { "id": 1, "actor": "...", "action": "...", "target": "...", "result": "ok", "details": null, "created_at": "..." } ] }`.
`limit` is clamped to 1..500.

## Config

### `GET /admin/api/config`

Returns non-secret runtime diagnostics: `{ host, port, chatMode, tls }`.
