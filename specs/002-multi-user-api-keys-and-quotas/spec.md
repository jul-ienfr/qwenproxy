# Feature Specification: Multi-User API Keys and Quotas

**Feature Branch**: `002-multi-user-api-keys-and-quotas`

**Created**: 2026-11-07

**Status**: Draft

**Input**: Gap analysis vs `pedrofariasx/qwenproxy`: per-user API keys with RPM
and concurrency ceilings, an admin key and normal keys, plus SQLite-backed
users. The current project has a single optional `API_KEY` and no per-user
quotas.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Issue isolated keys (Priority: P1)

An operator creates one API key per user or client so that revoking one key does
not disrupt the others.

**Why this priority**: A single shared key cannot be rotated, audited or
rate-limited per consumer. This is the minimum before exposing the proxy beyond
a single operator.

**Independent Test**: Create two keys, use each for a completion, revoke one, and
confirm only the revoked key receives 401.

**Acceptance Scenarios**:

1. **Given** an admin creates key K1 for user U1, **When** U1 calls
   `/v1/chat/completions` with K1, **Then** the request is accepted and attributed
   to U1.
2. **Given** K1 is revoked, **When** U1 retries, **Then** the response is 401 and
   no upstream request is made.
3. **Given** a request without a key and auth is required, **Then** the response
   is 401 with an OpenAI-style error envelope.

---

### User Story 2 - Enforce per-user quotas (Priority: P1)

An operator sets a requests-per-minute limit and a maximum number of concurrent
streams per user.

**Why this priority**: One client must not exhaust the Qwen account pool or the
process memory. The existing account concurrency is global, not per consumer.

**Independent Test**: Set `RPM=2` and `max_concurrency=1`; send three rapid
requests and two overlapping streams; observe 429 for the excess and success for
the allowed ones.

**Acceptance Scenarios**:

1. **Given** a user with RPM 60, **When** the 61st request arrives in the same
   minute, **Then** the response is 429 with `Retry-After`.
2. **Given** a user with `max_concurrency=1`, **When** a second stream starts
   before the first ends, **Then** the second is rejected with 429 and a clear
   concurrency message.
3. **Given** a rejected quota request, **Then** no account slot or Qwen request
   is consumed.

---

### User Story 3 - Separate administration from API use (Priority: P2)

An operator holds an admin key that can manage users and settings, while normal
keys can only call model endpoints.

**Why this priority**: A leaked normal key must not be able to create or delete
accounts, keys or settings.

**Independent Test**: Call an admin-only endpoint with a normal key and confirm
403; call it with the admin key and confirm success.

**Acceptance Scenarios**:

1. **Given** a normal key, **When** it calls `/admin/api/users`, **Then** the
   response is 403.
2. **Given** the admin key, **When** it calls the same endpoint, **Then** the
   response is 200.

### Edge Cases

- Key rotation while a stream is active: the in-flight stream completes; the next
  request fails.
- A user is deleted while holding an active stream: the stream completes or is
  aborted according to the existing stop semantics; no orphan quota slot remains.
- Two simultaneous first requests for the same key must not race the quota
  counter.
- Clock changes must not permanently lock a user's RPM window.
- The global `API_KEY` must keep working as an admin key for backward
  compatibility.
- Existing deployments with no users table must migrate without losing access.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST persist users with id, label, key hash, role, RPM
  limit, max concurrency and timestamps.
- **FR-002**: API keys MUST be stored hashed, not plaintext, and compared in
  constant time.
- **FR-003**: The system MUST support at least `admin` and `user` roles.
- **FR-004**: The system MUST enforce RPM per key and return 429 with
  `Retry-After` when exceeded.
- **FR-005**: The system MUST enforce concurrent stream limits per key and
  release slots on completion, abort or disconnect.
- **FR-006**: The system MUST attribute requests, tokens and errors to the
  calling user for usage reporting.
- **FR-007**: The admin role MUST be required for user management and settings
  mutation endpoints.
- **FR-008**: The legacy global `API_KEY` MUST remain valid as an admin key and
  preserve current single-user behavior.
- **FR-009**: Rate-limit and concurrency checks MUST happen before account
  selection or browser work.
- **FR-010**: The system MUST expose current user, limits and usage through the
  admin API and the web dashboard.
- **FR-011**: Revocation MUST take effect on the next request without a restart.

### Key Entities

- **User**: id, label, key hash, role, RPM, max concurrency, created/updated.
- **ApiKey**: hash, prefix for display, user, revoked timestamp.
- **UsageCounter**: user, window start, request count, active streams, token
  totals.
- **QuotaDecision**: allowed/rejected, reason, retry-after.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of requests are attributable to exactly one user.
- **SC-002**: RPM excess is rejected before any account slot is acquired.
- **SC-003**: A revoked key receives 401 on the next request.
- **SC-004**: Existing single-key deployments keep working without config
  changes.
- **SC-005**: Quota counters remain consistent under 50 concurrent requests in
  the regression test.

## Assumptions

- SQLite remains the default store; the schema can be extended with migrations.
- The web dashboard (spec 003) will consume the admin API rather than invent a
  second user model.
- Per-account quotas are out of scope; this spec covers per-consumer quotas.
- The existing `API_KEY` environment variable remains the bootstrap admin
  credential.
