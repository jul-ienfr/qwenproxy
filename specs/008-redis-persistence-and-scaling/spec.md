# Feature Specification: Redis Persistence and Multi-Instance Scaling

**Feature Branch**: `008-redis-persistence-and-scaling`

**Created**: 2026-11-07

**Status**: Draft

**Input**: Gap analysis vs `Rfym21/Qwen2API`: `DATA_SAVE_MODE=redis` with
`REDIS_URL`, plus multi-worker Docker. The current project uses SQLite only and
assumes a single process.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Share state across processes (Priority: P1)

An operator runs two proxy instances behind a load balancer and both see the
same accounts, sessions, users and cooldowns.

**Why this priority**: SQLite on a local volume cannot coordinate two workers;
without shared state, account cooldowns and sessions diverge.

**Independent Test**: Start two instances with the same Redis URL, create a
session on instance A, continue it on instance B, and verify the thread and
account binding are preserved.

**Acceptance Scenarios**:

1. **Given** two instances share Redis, **When** a session is created on A,
   **Then** B can continue it with the same upstream chat and parent id.
2. **Given** an account is cooled down on A, **When** B selects accounts,
   **Then** B sees the cooldown.
3. **Given** Redis is unavailable, **Then** the instance fails closed or falls
   back according to configuration, with a clear health state.

---

### User Story 2 - Preserve local-first behavior (Priority: P1)

A single-instance user can keep using SQLite with no Redis dependency.

**Why this priority**: The project must remain easy to run locally and in Docker
without extra infrastructure.

**Independent Test**: Start with no `REDIS_URL` and run the existing regression
suite.

**Acceptance Scenarios**:

1. **Given** no Redis URL, **Then** the system uses SQLite exactly as today.
2. **Given** a Redis URL, **Then** the system uses Redis for the configured
   domains and documents which domains remain local.
3. **Given** a Redis outage during a stream, **Then** the stream is not corrupted
   by a persistence error.

---

### User Story 3 - Migrate existing data (Priority: P2)

An operator can move accounts, users and sessions from SQLite to Redis without
recreating credentials.

**Why this priority**: A migration path avoids losing 29 configured accounts and
their encrypted passwords.

**Independent Test**: Run the migration command on a copy of the SQLite database
and verify account count, encrypted password decryption and session count.

**Acceptance Scenarios**:

1. **Given** an existing SQLite database, **When** migration runs, **Then** every
   account and user is present in Redis.
2. **Given** a migration failure, **Then** the source database is untouched and
   the migration is resumable.
3. **Given** encrypted passwords, **Then** they remain encrypted with the same
   key.

### Edge Cases

- Redis TLS (`rediss://`) and authentication.
- Network partition during a write; retry policy and idempotency.
- Two instances create the same session concurrently; last-write-wins or a
  compare-and-set strategy.
- Redis key eviction must not silently delete accounts or sessions.
- Large session history must not exceed Redis value limits.
- The process must still serve `/health` when Redis is down.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support an optional Redis persistence mode.
- **FR-002**: SQLite MUST remain the default and MUST work without Redis.
- **FR-003**: Redis mode MUST cover accounts, users, sessions and cooldowns at
  minimum.
- **FR-004**: Cooldowns and account selection MUST be consistent across
  instances.
- **FR-005**: Session continuation MUST work across instances.
- **FR-006**: Credentials MUST remain encrypted at rest in both backends.
- **FR-007**: A migration command MUST copy existing SQLite data to Redis
  without losing accounts or users.
- **FR-008**: Redis outages MUST be observable and MUST NOT corrupt in-flight
  streams.
- **FR-009**: The system MUST document which data remains local (for example
  browser profiles) and which is shared.
- **FR-010**: Multi-instance deployment MUST be documented with a Docker
  Compose example.

### Key Entities

- **PersistenceBackend**: SQLite or Redis, selected by configuration.
- **SharedAccount**: account record and cooldown state.
- **SharedSession**: logical thread, chat id, parent id, account binding.
- **MigrationRun**: source, target, counts, status, errors.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A session created on one instance continues on another with the
  same upstream chat.
- **SC-002**: Account cooldowns are visible across instances within 1 second.
- **SC-003**: Existing SQLite-only tests pass unchanged.
- **SC-004**: Migration preserves 100% of accounts and users.
- **SC-005**: Redis outage is reported by `/health` without taking down the
  process.

## Assumptions

- Redis is optional infrastructure provided by the operator.
- Browser profiles remain local to each instance; only serializable state is
  shared.
- Redis may be single-node or managed with TLS.
- The first release may share accounts/cooldowns/users but keep sessions local
  if cross-instance session routing is too complex; the plan must state the
  chosen scope.
