# Feature Specification: Authenticated Web Administration Dashboard

**Feature Branch**: `003-web-admin-dashboard`

**Created**: 2026-11-07

**Status**: Draft

**Input**: Gap analysis vs `pedrofariasx/qwenproxy` (`/admin` React + shadcn
dashboard), `Rfym21/Qwen2API` and `xiaoY233/Chat2API`: the current project only
exposes a terminal UI plus `/health`, `/metrics` and `/logs`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Operate the proxy from a browser (Priority: P1)

An operator opens an authenticated dashboard and sees account health, active
streams, request rate, error rate, latency, memory and token usage at a glance.

**Why this priority**: The TUI is usable on the host machine but not from another
device and not during an incident where a visual overview is faster.

**Independent Test**: Load the dashboard with a valid admin session, confirm
every KPI matches `/metrics` and `/health`, and confirm the page updates without
a manual refresh.

**Acceptance Scenarios**:

1. **Given** an authenticated admin, **When** the dashboard loads, **Then** the
   overview shows account count, ready accounts, active streams, RPM, error rate,
   latency and memory.
2. **Given** a new request completes, **When** the live channel is connected,
   **Then** the counters update within 5 seconds.
3. **Given** the live channel disconnects, **Then** the UI falls back to polling
   and shows a degraded-live indicator.

---

### User Story 2 - Manage accounts safely (Priority: P1)

An operator adds, removes, cools down or refreshes an account and edits its
per-account proxy without editing SQLite by hand.

**Why this priority**: Account operations are the most frequent operational task
and the most likely source of credential or cooldown mistakes.

**Independent Test**: Add a test account, set a proxy, clear its cooldown, delete
it, and confirm each change through the API and the account list.

**Acceptance Scenarios**:

1. **Given** an admin on the Accounts page, **When** they add an account, **Then**
   it appears in the list and the credential is stored encrypted.
2. **Given** an account on cooldown, **When** the admin clears it, **Then** the
   next request may select it.
3. **Given** an account removal, **Then** its browser profile and sessions are
   removed only after confirmation.

---

### User Story 3 - Manage users, keys and settings (Priority: P2)

An operator creates users, rotates keys, edits RPM/concurrency limits and changes
allowlisted runtime settings from the dashboard.

**Why this priority**: These surfaces depend on spec 002 and replace manual
`.env` edits for routine operations.

**Independent Test**: Create a user with a limit, change the limit, revoke the
key, and confirm the API behavior changes immediately.

**Acceptance Scenarios**:

1. **Given** the Users page, **When** a user is created, **Then** the key is
   shown exactly once and stored hashed.
2. **Given** a settings change, **When** it is saved, **Then** the allowlisted
   value is persisted and the running process applies it without a full restart
   where the existing config supports hot reload.

### Edge Cases

- Dashboard is exposed on a non-loopback interface without TLS; the spec must
  require an explicit warning or a secure-cookie policy.
- Admin session expires during a long operation; the UI must fail closed.
- A browser refresh during an SSE stream must not duplicate event handlers.
- Account email and proxy credentials must be masked in list responses.
- Multiple admins edit the same account concurrently; last write wins with an
  audit record.
- The dashboard must remain usable when the Qwen upstream is down.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The dashboard MUST be served by the existing proxy process under an
  authenticated path and MUST NOT require a second server.
- **FR-002**: Authentication MUST use a signed HttpOnly session cookie with an
  explicit expiry; credentials MUST NOT be stored in localStorage.
- **FR-003**: The overview MUST show account health, active streams, RPM, error
  rate, latency, memory and token usage.
- **FR-004**: The dashboard MUST provide live updates via SSE with an automatic
  polling fallback.
- **FR-005**: The Accounts page MUST support add, remove, cooldown clear, header
  refresh, per-account proxy edit and masked status.
- **FR-006**: The Users page MUST support create, edit limits, rotate key and
  revoke, depending on spec 002.
- **FR-007**: The Settings page MUST edit only allowlisted environment values and
  MUST reject unknown keys.
- **FR-008**: The Models page MUST show the live catalog and model capabilities.
- **FR-009**: The Logs page MUST show recent structured logs with secret
  redaction and a level filter.
- **FR-010**: Every mutating action MUST require the admin role and produce an
  audit record.
- **FR-011**: The UI MUST be responsive and usable on a phone for incident
  checks.
- **FR-012**: The existing TUI MUST remain available.

### Key Entities

- **AdminSession**: signed session, expiry, role, CSRF token.
- **DashboardEvent**: metric or state update pushed over SSE.
- **AuditRecord**: actor, action, target, timestamp, result.
- **SettingDescriptor**: key, type, allowlist, default, restart requirement.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can identify which account is failing within 30 seconds
  of opening the dashboard.
- **SC-002**: Account add/remove/cooldown actions complete without editing files
  or restarting the proxy.
- **SC-003**: No secret appears in HTML, API JSON, logs or browser storage.
- **SC-004**: The dashboard remains reachable when Qwen is unavailable.
- **SC-005**: The TUI and dashboard report the same account and stream counts.

## Assumptions

- The existing Hono server can serve static assets and authenticated JSON
  endpoints.
- The frontend stack will be chosen in the plan (React or server-rendered); this
  spec does not mandate it.
- Spec 002 provides the user/key model; this dashboard is the first consumer.
- The dashboard is for a trusted operator network; public multi-tenant exposure
  requires TLS and additional hardening.
