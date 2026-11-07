# Quickstart: Authenticated Web Administration Dashboard

**Feature**: `003-web-admin-dashboard`

## Prerequisites

- A working QwenProxy install (spec 001) and, for the Users tab, spec 002.
- Node.js 22+ and the existing dependencies (`npm install`).
- The proxy reachable from the browser. On a remote host, use TLS or a trusted
  tunnel; the dashboard warns when served over plain HTTP on a non-loopback
  address.

## Start

```bash
npm start
```

Open `http://127.0.0.1:3000/admin`.

## Sign in

- **With `API_KEY`:** enter that key in the login form.
- **With a spec 002 admin user key:** enter the `sk-qpx-...` key for a user whose
  role is `admin`.
- **No-key loopback install:** leave the field empty and submit; the historical
  local-admin trust applies.

The server sets an HttpOnly `qpx_admin` cookie (8h) and returns a CSRF token that
the UI keeps in memory only.

## What you can do

| Tab | Actions |
| --- | --- |
| Overview | KPIs (accounts, streams, RPM, errors, latency, memory, tokens, uptime) and a live account table |
| Accounts | Add/remove, clear cooldown, refresh headers, edit per-account proxy |
| Users | Create, edit RPM/concurrency, rotate key, revoke |
| Models | Live catalog with context window and capabilities |
| Settings | Allowlisted hot-applied settings persisted to `.env` |
| Logs | Recent structured logs with level filter and secret redaction |
| Audit | Recent mutations with actor/target/result |

Live updates use SSE (`/admin/api/events`); if SSE fails the UI polls every 5s
and shows `polling (degraded)`.

## API examples

```bash
# Create a session (cookie jar)
curl -i -c cookies.txt \
  -H 'content-type: application/json' \
  -d '{"apiKey":"sk-your-admin-key"}' \
  http://127.0.0.1:3000/admin/api/session

# Overview with a bearer key (no CSRF needed)
curl -H 'Authorization: Bearer sk-your-admin-key' \
  http://127.0.0.1:3000/admin/api/overview

# Mutation with a cookie requires the CSRF token returned at login
curl -b cookies.txt -H 'content-type: application/json' \
  -H 'x-csrf-token: <csrf>' \
  -d '{"values":{"rate_limit_requests":1000}}' \
  -X PUT http://127.0.0.1:3000/admin/api/settings
```

## Troubleshooting

- **401 on every call:** the session expired or the key is invalid. Sign in
  again; `DELETE /admin/api/session` clears a stale cookie.
- **403 `Invalid CSRF token`:** the `x-csrf-token` header is missing or stale.
  Reload the dashboard to obtain a fresh session token.
- **Cookies not sent:** the cookie path is `/admin`; requests to other paths do
  not include it. `Secure` is added automatically over HTTPS.
- **Live indicator stays degraded:** an intermediary buffers SSE. The dashboard
  keeps working via polling.
- **Dashboard reachable but Qwen is down:** this is expected; overview, accounts,
  users, settings, models (cached), logs and audit use local state.

## Restart behavior

The signing secret lives at `data/db/.admin_session_secret`, so sessions survive
a process restart. Deleting that file invalidates every existing session.
