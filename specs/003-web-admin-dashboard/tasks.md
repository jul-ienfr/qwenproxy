# Tasks: Authenticated Web Administration Dashboard

**Feature**: `003-web-admin-dashboard`
**Plan**: [plan.md](plan.md)
**Spec**: [spec.md](spec.md)

## Phase 1 — Foundation

- [x] T001 Add the `admin_audit` table and index in `src/core/database.ts`.
- [x] T002 Extract credential precedence into `src/core/auth-identity.ts` and use
  it from `/v1` and the dashboard login.
- [x] T003 Add `src/core/admin-session.ts`: HMAC signed cookie, persisted secret,
  TTL, cookie attributes, CSRF validation.
- [x] T004 Add `src/core/admin-audit.ts` with fail-soft `recordAudit`/`listAudit`.
- [x] T005 Add `src/core/overview-stats.ts` for 60-second request/error windows.

## Phase 2 — Dashboard router and authentication

- [x] T006 Add `src/admin/auth.ts`: bearer/session authentication, admin role,
  CSRF and same-origin checks, local-admin fallback.
- [x] T007 Add `src/admin/app.ts`: static UI, session, overview, SSE, settings,
  models, logs, audit, config.
- [x] T008 Replace the `/admin/*` middleware with `/admin/api/*`, skipping only
  `/admin/api/session`, and mount the dashboard at `/admin`.
- [x] T009 Narrow `adminUsersApp` middleware to `/api/users*` so it does not block
  the dashboard UI.
- [x] T010 Preserve spec 002 semantics: legacy `API_KEY`, DB keys, loopback
  no-key admin, revoked `sk-qpx-` keys rejected.

## Phase 3 — Accounts

- [x] T011 Add `src/admin/accounts-api.ts`: list (masked), add, delete,
  clear one/all cooldowns, refresh headers, edit proxy.
- [x] T012 Mask account emails beyond the first two local-part characters and
  rely on `loadAccounts()` masking for proxies/passwords.
- [x] T013 Audit every account mutation.

## Phase 4 — Overview, logs, models, settings

- [x] T014 Add `src/admin/overview.ts`: KPI and account snapshots from local
  state only.
- [x] T015 Hook `recordOverviewRequest` at `requests.total` and
  `recordOverviewError` for 5xx responses.
- [x] T016 Add `src/admin/logs.ts` and redact secrets in REST and SSE log views.
- [x] T017 Export `loadModelsWithVariants` from `src/api/models.ts` and expose a
  dashboard models endpoint.
- [x] T018 Add `src/admin/settings.ts` with the seven-key allowlist, validation
  and `.env` persistence.

## Phase 5 — UI and audit

- [x] T019 Add embedded responsive HTML/CSS/JS in `src/admin/ui.ts` with tabs,
  KPIs, SSE + polling fallback, log level filter and confirmation prompts.
- [x] T020 Use `textContent`/`createElement` only; keep the CSRF token in memory.
- [x] T021 Add audit records to user create/limits/rotate/revoke.

## Phase 6 — Documentation and tests

- [x] T022 Write plan, research, data model, contract, quickstart and tasks.
- [x] T023 Add `src/tests/admin-session.test.ts`.
- [x] T024 Add `src/tests/admin-dashboard.test.ts`.
- [x] T025 Add `src/tests/admin-accounts.test.ts`.
- [x] T026 Add `src/tests/admin-settings.test.ts`.
- [ ] T027 Update README, `.env.example` and feature-gap notes.
- [ ] T028 Run `npm run typecheck` and the targeted plus existing auth tests.
- [ ] T029 Restart the live proxy and verify login, cookie/CSRF, SSE, accounts,
  users, settings and logs.

## Dependencies

- T001/T002/T003/T004 before T006/T007.
- T006 before T008/T009.
- T011 before T013.
- T018 before T026.
- T028/T029 after T022–T027.

## Out of scope

- Public multi-tenant exposure without TLS.
- Per-user dashboard (all dashboard users are admins in this slice).
- Replacing the TUI.
- Token/cost quotas (tracked, not enforced).
