# Feature Specification: Engineering Hardening (Reliability, Performance, Quality, Modularity)

**Feature Branch**: `016-engineering-hardening`

**Created**: 2026-11-16

**Status**: Draft

**Input**: Operator request — "audit complet et exhaustif pour fiabiliser, rendre
plus qualitatif, plus modulable, plus performant, plus rapide, avec le maximum de
performance, de qualité et de maintenabilité", followed by a Spec Kit plan. The
evidence base is [`docs/AUDIT-2026-11-16.md`](../../docs/AUDIT-2026-11-16.md)
(commit `a9da064`, version 1.6.13). Every requirement below cites the audit
finding it closes (`S#` security, `R#` reliability, `P#` performance,
`A#` architecture, `T#` tests/CI).

This is a **hardening epic**, not a new capability. It adds no endpoint and no
protocol. It closes one critical security defect, removes quadratic cost from the
streaming hot path, makes state transitions recoverable, and makes the module
boundaries and the test gate mechanically enforceable.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A hostile web page cannot drive the dashboard (Priority: P1)

An operator runs qwenproxy on the default installation: bound to loopback, no
`API_KEY` configured. They browse the web in the same browser. A malicious page
resolves its own hostname to `127.0.0.1` on the proxy port (DNS rebinding) and
issues same-origin requests to `/admin/api/*`. Today it obtains full admin: it can
rewrite `PROXY_URL` to intercept all Qwen traffic, add accounts, mint admin users,
and read logs and the account list.

After this story, the request is rejected before any identity is resolved,
because the `Host` header is not a trusted authority for this listener.

**Why this priority**: This is the only finding that lets an unauthenticated
remote party take over a default installation (audit **S1**, confirmed by direct
read of `src/admin/auth.ts:136-161`, `:190-198` and
`src/core/auth-identity.ts:115-118`). No inbound `Host` validation exists anywhere
in `src/`. Everything else in this epic is a quality or cost problem; this one is
a compromise.

**Independent Test**: Boot the app with no `API_KEY` on loopback. Issue
`PUT /admin/api/settings` with `Origin: http://evil.test:<port>` **and**
`Host: evil.test:<port>` (the rebinding case where both agree). Assert `403` and
assert no setting changed. Then assert the legitimate loopback dashboard and a
configured reverse-proxy hostname still work. No network, no Qwen account.

**Acceptance Scenarios**:

1. **Given** no `API_KEY` and a loopback bind, **When** a mutating admin request
   arrives with `Host: evil.test:<port>` and a matching `Origin`, **Then** it is
   rejected with `403` and no state changes — even though Origin and Host agree.
2. **Given** the same installation, **When** a request arrives with no `Origin`
   header and an untrusted `Host`, **Then** it is still rejected (the current
   code returns "allowed" when `Origin` is absent).
3. **Given** the same installation, **When** the operator uses the real dashboard
   at `http://127.0.0.1:<port>` or `http://localhost:<port>`, **Then** every
   existing admin behaviour is unchanged, including the no-key legacy path.
4. **Given** a deployment behind a TLS-terminating reverse proxy on a configured
   public hostname, **When** the operator declares that hostname as trusted,
   **Then** the dashboard works and the existing "origin checks tolerate a TLS
   proxy" test stays green.
5. **Given** a non-loopback bind, **When** the server starts, **Then** the
   existing key requirement is unchanged and the trusted-authority set is derived
   from the bound host.
6. **Given** an untrusted-`Host` rejection, **Then** it is counted and logged
   without echoing request bodies or credentials.

---

### User Story 2 - The default test gate is green, hermetic and complete (Priority: P1)

A contributor runs the project's default test command on a clean checkout with no
Qwen credentials and no network. Today `npm test` also runs live tests, and
`npm run test:mock` finishes **red** for a reason unrelated to any assertion, while
43 already-passing assertions — including the whole multi-user key, quota and
migration surface — are never executed at all.

After this story, one command runs every mock test exactly once, from a single
source of truth, and finishes green.

**Why this priority**: Constitution VI requires a passing gate, and every other
story in this epic is verified by that gate. Until it is green and complete, no
later fix is attributable. It is also the cheapest story in the epic.

**Independent Test**: On a machine with no Qwen accounts and outbound network
blocked, run the default test command. Assert it exits 0, that the executed file
set equals `src/tests/*.test.ts` minus the two declared live files, and that the
previously orphaned files appear in the run.

**Acceptance Scenarios**:

1. **Given** a clean checkout with no credentials, **When** the default test
   command runs, **Then** it performs no outbound Qwen request and exits 0.
2. **Given** the 166 test files, **When** the mock suite runs, **Then** all 164
   non-live files are executed, including `users`, `users-migration`,
   `user-auth`, `user-quota`, `account-proxy`, `mutex-epoch`,
   `stale-stream-slot-sweeper`, `tool-call-heuristics`, `apply-upstream-usage`
   and `timezone-ascii`.
3. **Given** a newly added `src/tests/foo.test.ts`, **When** the suite runs,
   **Then** it is picked up with **no edit to any list**.
4. **Given** the current `server-lifecycle` failure, **When** the suite runs,
   **Then** the runner-channel error is either eliminated or reproduced as an
   attributable, documented failure — never silently skipped.
5. **Given** the two live suites, **When** an operator wants them, **Then** they
   run only through an explicit opt-in command.
6. **Given** the fast variant, **Then** it differs from the default only by
   concurrency, and both derive from the same file set.

---

### User Story 3 - Long agent turns stay linear and bounded (Priority: P1)

A coding agent streams a long turn: a large file write, a long reasoning trace, or
a cumulative upstream response. Today the proxy's per-chunk work grows with the
bytes already delivered, so a 1 MB answer can copy hundreds of megabytes and block
the event loop; a slow client can make the write buffer grow without bound; and
the escape decoder both wastes four passes and **corrupts content**.

After this story, per-chunk work is proportional to the new bytes, the writer
respects the consumer, and every legal JSON escape decodes correctly.

**Why this priority**: This is the operator's "maximum de performance" request
aimed at the actual product workload. It also carries a correctness defect
(audit **P3**): `\uXXXX` is not decoded at all, and escape order corrupts literal
backslash sequences such as Windows paths.

**Independent Test**: Counter-instrumented micro-benchmarks, no network: feed a
synthetic answer of 10 KB → 1 MB in 1 KB deltas through the delta deduplicator and
the tool parser, and assert total scanned/copied bytes stay linear. Separately,
assert a table of escape inputs decodes to the exact expected string. Separately,
assert a throttled consumer bounds the pending write buffer.

**Acceptance Scenarios**:

1. **Given** a strictly incremental stream of N bytes in fixed-size deltas,
   **When** it is deduplicated, **Then** total bytes copied is O(N), not O(N²),
   and the emitted text is byte-identical to today's output.
2. **Given** a cumulative stream, **When** chunks are parsed, **Then** the
   already-scanned prefix is not re-scanned per chunk.
3. **Given** content containing `\u00e9`, `\r`, `\/`, `\b`, `\f`, a literal
   backslash-n and a Windows path, **When** the fast path decodes it, **Then**
   the result equals `JSON.parse` of the same string body — for every case.
4. **Given** a valid payload with no escapes needing repair, **Then** output
   bytes are unchanged and exactly one decode pass runs.
5. **Given** a consumer that reads slower than the producer, **When** the stream
   runs, **Then** pending buffered bytes stay under a declared bound and the
   producer is slowed rather than the heap growing.
6. **Given** a large tool-call payload containing a literal close tag inside a
   JSON string, **When** it is fed in chunks, **Then** parser work stays linear
   and the spec 015 integrity guarantees still hold.
7. **Given** any of the above, **Then** streaming stays incremental: no answer
   is buffered whole before the first client delta.

---

### User Story 4 - Shutdown, crashes and quota state are recoverable (Priority: P2)

An operator restarts the proxy while requests are in flight, or the process hits
an unexpected exception, or SQLite is briefly locked at startup. Today the
browser is closed **before** in-flight requests are drained (so active streams
die mid-generation), a non-benign crash is logged and then **swallowed** while the
process keeps serving from an undefined state, shutdown has no forced-exit bound,
and a transient DB read failure permanently disables per-model quota holds for
the life of the process.

**Why this priority**: These are silent, operator-visible reliability failures
(audit **R1, R2, R3, R6, R9**) that directly violate constitution XI
("fail closed, bound every retry, timeout and buffer, make startup and shutdown
idempotent"). They do not compromise the install, so they follow P1.

**Independent Test**: Unit/integration tests with mocked browser and DB: assert
cleanup ordering by recorded call sequence; assert a non-benign error triggers
process exit while a benign teardown error does not; assert a forced-exit timer
fires when drain hangs; assert a failed first quota load is retried and the hold
is honoured afterwards; assert timers and stream-registry entries are released on
the failure path.

**Acceptance Scenarios**:

1. **Given** an in-flight streaming request, **When** shutdown begins, **Then**
   the HTTP server stops accepting and drains **before** the browser closes, and
   the stream completes or terminates cleanly.
2. **Given** a drain that never completes, **When** the grace period elapses,
   **Then** the process exits non-zero exactly once.
3. **Given** a signal during account warmup, **When** it arrives, **Then**
   cleanup still runs (handlers are installed before warmup).
4. **Given** a non-benign uncaught exception or unhandled rejection, **Then** it
   is logged and the process exits non-zero; **given** a genuine Playwright/CDP
   teardown error, the process continues.
5. **Given** an empty/falsy rejection reason or a generic message such as
   "Connection closed" from non-browser code, **Then** it is **not** classified
   benign.
6. **Given** the first per-model quota load fails, **When** quota state is next
   read, **Then** loading is retried and an existing hold is still enforced.
7. **Given** a persistence write that fails, **Then** it is logged at debug/warn
   without secrets, never silently discarded.
8. **Given** a request that fails between upstream acquisition and stream
   processing, **Then** the stream-registry entry, the account lease and the
   chat lock are all released, and no acquire-deadline timer survives.
9. **Given** a personalization sync that outlives its deadline, **Then** its
   mutex is not released while the operation is still running.
10. **Given** repeated start/stop cycles, **Then** shutdown remains idempotent
    and leaves no orphan browser or pending handle.

---

### User Story 5 - Credentials at rest are encrypted and owner-only (Priority: P2)

An operator runs the proxy on a shared Linux host or a Docker volume. Today
account passwords are encrypted, but the Qwen session **cookie** and
**refresh token** are written to SQLite in cleartext, inside a directory created
world-readable. Any local user can read them and impersonate the accounts.

**Why this priority**: Constitution III states credentials MUST be encrypted at
rest with the existing AES-256-GCM mechanism (audit **S2**). This is a real
exposure but requires local access, so it follows the remote-compromise story.

**Independent Test**: Save an auth session against a temp DB, then read the raw
file bytes and assert the cookie and refresh token do not appear in cleartext;
assert the round-trip still returns them; assert a pre-existing cleartext row is
migrated transparently; assert directory/file modes on POSIX and graceful
behaviour on Windows.

**Acceptance Scenarios**:

1. **Given** a saved auth session, **When** the DB file is read as bytes, **Then**
   neither the cookie nor the refresh token nor the bx tokens appear in
   cleartext.
2. **Given** an existing installation with cleartext rows, **When** the server
   starts, **Then** rows are migrated in place, once, idempotently, and sessions
   keep working without re-login.
3. **Given** a row that cannot be decrypted, **Then** the account is surfaced as
   a credential error and excluded from rotation instead of silently becoming an
   empty password.
4. **Given** a POSIX host, **Then** the data directory is owner-only and the DB
   file is owner-read/write; **given** Windows, the call succeeds without error
   and without weakening ACLs.
5. **Given** any log or error produced by these paths, **Then** no credential
   value is emitted.

---

### User Story 6 - Per-request work is proportionate and observable (Priority: P3)

An operator runs many concurrent agent sessions. Today every request performs a
synchronous SQLite `DELETE` before its throttle check (at least three times per
request), rebuilds and re-measures the whole prompt even when only a delta is
sent, writes telemetry synchronously per turn, and logs unconditionally. A test
hook can also silently shrink production retry delays, and the watchdog reports
stream "recovery" that does nothing.

**Why this priority**: These are real, measurable costs and operability gaps
(audit **P7, P8, P9, P11, R4, R5, R7, R8**) but none is a correctness or security
defect. They are the sustained-throughput work.

**Independent Test**: Instrumented counts, no network: assert zero synchronous
account-table writes on a warm cache; assert the full prompt is materialised only
when a replay actually needs it; assert token estimation runs once per distinct
prompt per attempt; assert retry-delay defaults are unaffected by the test hook
outside test mode; assert the watchdog either performs a real action or reports
no recovery.

**Acceptance Scenarios**:

1. **Given** a warm account cache within the sync interval, **When** accounts are
   loaded repeatedly, **Then** no `DELETE` is issued.
2. **Given** an env-account change, **Then** reconciliation still happens exactly
   once and removed accounts do not resurrect.
3. **Given** a thread-native delta continuation, **When** the request is built,
   **Then** the full history string is not materialised unless a replay occurs,
   and the upstream payload is unchanged.
4. **Given** one attempt, **Then** the same prompt text is token-estimated at
   most once, and truncation/limits/context-meter agree on the result.
5. **Given** `TEST_MOCK_QWEN_AUTH=true` outside a test runtime, **Then** retry
   timing defaults are the production values and the condition is reported.
6. **Given** stream pressure above the critical threshold, **Then** the watchdog
   either takes a bounded real action or reports that it took none — never a
   false "recovered" signal.
7. **Given** every account in cooldown, **Then** the pool behaves as a bounded
   half-open breaker instead of immediately retrying the shortest cooldown.
8. **Given** a corrupt database at startup, **Then** the failure is diagnosed
   with an actionable message rather than an opaque throw.
9. **Given** default log level, **Then** per-request logging is gated, and
   `/health` and `/metrics` keep their existing shape.

---

### User Story 7 - Module boundaries are mechanically enforceable (Priority: P3)

A maintainer changes one module. Today the upstream core is a single
10-file strongly connected component, the domain imports the terminal UI and the
route layer, 16 files exceed 800 lines, the published package's entry point is raw
TypeScript, and nothing checks any of this — there is no lint, no format gate, no
dependency audit and no import-boundary rule.

**Why this priority**: This is the "plus modulable / maximum de maintenabilité"
request (audit **A1–A10, T5, T6**). It is the largest and riskiest work, so it
lands last, after the gate is green and the behaviour fixes are proven.

**Independent Test**: A boundary check that fails on the current tree and passes
after each inversion; a lint/format/audit/build gate in CI; a package smoke test
that imports the published entry point without `tsx`.

**Acceptance Scenarios**:

1. **Given** the import graph, **When** the boundary check runs, **Then** the
   domain layer no longer imports presentation (`core → routes`, `core → tui`)
   and no service imports an entry point.
2. **Given** the 10-file cycle, **When** it is broken, **Then** each extracted
   unit is importable in isolation and the previously coupled suites stay green.
3. **Given** the published package, **When** a consumer imports its entry point,
   **Then** it resolves to built output, deep internals are not part of the
   public surface, and `tsx` is not a production dependency.
4. **Given** CI, **Then** lint, format, dependency audit and package build are
   gates, and a release cannot be cancelled between tag and publish.
5. **Given** a large file split, **Then** behaviour is unchanged, each new module
   has one responsibility, and no public endpoint or wire format changes.
6. **Given** the stricter compiler settings, **Then** typecheck passes and the
   `any` count is reduced without introducing suppression comments.

---

### Edge Cases

- Rebinding where `Origin` is absent, malformed, or `null`; where `Host` carries
  an explicit default port, an IPv6 literal, or unusual case.
- A legitimate reverse proxy that rewrites `Host`, and adapter self-fetches that
  use the derived internal origin — both must keep working.
- A wildcard bind (`0.0.0.0` / `::`) where no single bound hostname exists.
- A delta shorter than the suffix window; an empty delta; a delta that is exactly
  the previous content; a stream that switches between cumulative and incremental
  mid-answer.
- An escape sequence split across chunk boundaries; an incomplete `\uXXXX` at
  flush; a lone trailing backslash.
- A literal tool close tag inside a JSON string value (spec 015 interaction).
- Shutdown with zero in-flight requests, with a hung browser close, and with a
  second signal arriving during the first shutdown.
- A benign-looking message ("Connection closed") raised by non-browser code.
- Quota load failing on first read, then succeeding; a hold expiring while the
  load is still failing.
- Cleartext and encrypted auth rows coexisting during migration; a rotated
  encryption key; a read-only data directory.
- Windows (POSIX modes ignored), macOS, and Linux for every filesystem and signal
  change.
- A test file added, renamed to a live name, or deleted, with no list to update.

## Requirements *(mandatory)*

### Functional Requirements

**Admin surface (US1 — S1, S4)**

- **FR-001**: Every HTTP request MUST be rejected before identity resolution when
  its `Host` authority is not in the listener's trusted-authority set.
- **FR-002**: The trusted set MUST default to loopback authorities plus the
  configured bound host, and MUST be extensible by explicit operator
  configuration for reverse-proxy hostnames.
- **FR-003**: Host comparison MUST be case-insensitive, MUST handle IPv6 literals
  and explicit/implicit default ports, and MUST NOT depend on the `Origin` header
  being present.
- **FR-004**: The existing Origin/Host cross-origin check and CSRF validation MUST
  be retained as defence in depth, not replaced.
- **FR-005**: The no-key legacy admin path MUST additionally require a loopback
  peer address; it MUST NOT be granted on the strength of headers alone.
- **FR-006**: Rejections MUST be counted and logged without request bodies or
  credentials, and MUST NOT change any existing success response shape.
- **FR-007**: `.gitignore` MUST cover `.env.*` while continuing to allow
  `.env.example` and `.env.test`.

**Test gate (US2 — T1, T2, T3, T4)**

- **FR-008**: The default test command MUST run only hermetic tests and MUST NOT
  require Qwen credentials or outbound network.
- **FR-009**: Live tests MUST run only via an explicit opt-in command.
- **FR-010**: The mock file set MUST be derived from a single source of truth, so
  a new test file is executed without editing any list.
- **FR-011**: All currently orphaned mock files MUST be executed, and their
  assertions MUST pass unmodified.
- **FR-012**: The fast variant MUST share the same file set and differ only in
  concurrency.
- **FR-013**: The `server-lifecycle` runner-channel failure MUST be resolved or
  recorded as an attributable, reproducible defect with its cause; it MUST NOT be
  hidden by removing or skipping the file.
- **FR-014**: The recorded suite baseline in `specs/README.md` MUST be corrected
  to the measured numbers.

**Streaming cost and correctness (US3 — P1, P2, P3, P4, P5)**

- **FR-015**: Delta deduplication MUST NOT force flattening of the accumulated
  answer; per-chunk work MUST be proportional to the new bytes.
- **FR-016**: Emitted delta bytes MUST remain byte-identical to current behaviour
  for cumulative, incremental and mixed streams.
- **FR-017**: SSE chunk parsing MUST NOT re-scan the already-parsed prefix of a
  cumulative line on every chunk.
- **FR-018**: The fast-path escape decoder MUST produce exactly what a single
  native JSON string decode produces, for every legal escape, in one pass.
- **FR-019**: Tool-call block-boundary scanning MUST be incremental; the
  already-scanned buffer prefix MUST NOT be re-scanned or re-parsed per feed.
- **FR-020**: All spec 015 guarantees (parseable arguments, no merged or lost
  calls, prefix stability, bounded retries) MUST still hold.
- **FR-021**: Client writes MUST propagate backpressure so pending buffered bytes
  per stream stay under a declared bound; the existing micro-buffer and heartbeat
  MUST be preserved.
- **FR-022**: Every performance fix MUST be preceded by a failing measurement, and
  MUST NOT change the upstream transport (constitution II).

**State transitions (US4 — R1, R2, R3, R6, R9)**

- **FR-023**: Shutdown MUST drain in-flight HTTP requests before closing the
  browser, then flush thread state, then close Redis and SQLite.
- **FR-024**: Shutdown MUST be bounded by a forced-exit timer that exits non-zero
  exactly once, and MUST remain idempotent under repeated calls and signals.
- **FR-025**: Signal handlers MUST be installed before account warmup begins.
- **FR-026**: A non-benign uncaught exception or unhandled rejection MUST be
  logged and MUST terminate the process non-zero.
- **FR-027**: Benign-teardown classification MUST require browser/CDP evidence;
  falsy reasons, empty objects and generic connection messages MUST NOT qualify.
- **FR-028**: Per-model quota state MUST mark itself loaded only after a
  successful load, and MUST retry a failed load instead of staying empty for the
  process lifetime.
- **FR-029**: Quota persistence failures MUST be logged without secrets rather
  than swallowed.
- **FR-030**: Every request failure path MUST release the stream-registry entry,
  the account lease and the chat lock, and MUST clear its deadline timers.
- **FR-031**: A personalization mutex MUST NOT be released while its underlying
  operation is still running.
- **FR-032**: Long-lived registries MUST have a bounded sweep so an abandoned
  entry cannot retain credentials indefinitely.

**Credentials at rest (US5 — S2, S3)**

- **FR-033**: Qwen session cookies, bx tokens and refresh tokens MUST be encrypted
  at rest with the existing AES-256-GCM mechanism.
- **FR-034**: Existing cleartext rows MUST be migrated once, idempotently, without
  forcing re-login and without logging values.
- **FR-035**: The data directory MUST be owner-only and the DB file owner-only
  read/write on POSIX; on Windows the operation MUST succeed without error.
- **FR-036**: An undecryptable credential MUST surface as an explicit account
  error and exclude the account from rotation; it MUST NOT become an empty
  password or a raw ciphertext proxy URL.

**Per-request cost and operability (US6 — P7, P8, P9, P11, R4, R5, R7, R8)**

- **FR-037**: Account reconciliation MUST NOT write to SQLite before its throttle
  check; a warm cache MUST issue no write.
- **FR-038**: The full prompt string MUST be materialised lazily, only when a
  replay or a limit check actually needs it; upstream payloads MUST be unchanged.
- **FR-039**: Token estimation MUST be memoised per distinct prompt text within an
  attempt, and all consumers MUST agree on the result.
- **FR-040**: Length caps MUST be evaluated before any trimming or copying of
  response content.
- **FR-041**: Telemetry writes MUST NOT block the request path.
- **FR-042**: Per-request logs MUST be gated by the configured level.
- **FR-043**: Test-only hooks MUST NOT alter production behaviour, including retry
  timing defaults; the hook MUST be documented.
- **FR-044**: The watchdog MUST either perform a bounded real stream-recovery
  action or report that no action was taken.
- **FR-045**: When the whole pool is in cooldown, selection MUST behave as a
  bounded half-open breaker.
- **FR-046**: Startup MUST diagnose database integrity failures with an actionable
  message.
- **FR-047**: Unbounded caches MUST have a size bound in addition to their TTL.

**Boundaries and gates (US7 — A1–A10, T5, T6)**

- **FR-048**: The domain layer MUST NOT import presentation or UI layers, and
  services MUST NOT import process entry points; this MUST be checked
  mechanically.
- **FR-049**: The 10-file import cycle MUST be broken so each extracted unit is
  importable in isolation.
- **FR-050**: The published entry point MUST resolve to built output, the public
  surface MUST be declared explicitly, and the TS runtime loader MUST NOT be a
  production dependency.
- **FR-051**: CI MUST gate lint, format, dependency audit and package build; a
  release MUST NOT be cancellable between tag and publish.
- **FR-052**: Compiler strictness MUST be increased and the `any` count reduced
  without adding suppression comments.
- **FR-053**: Large-file splits MUST preserve behaviour and public endpoints, and
  MUST land as small reviewable diffs.
- **FR-054**: `.env.example` MUST match the actual defaults and document every
  supported variable.

### Key Entities

- **Trusted authority set**: the host/port authorities a listener accepts, derived
  from bind host plus explicit operator configuration; consulted before identity.
- **Mock test manifest**: the single derived set of hermetic test files, with live
  files declared separately.
- **Delta cursor**: per-stream position and short suffix used to compute the next
  delta without flattening the accumulated answer.
- **Incremental scan cursor**: per-parser offset and string/escape state carried
  across feeds so only new bytes are examined.
- **Write budget**: per-stream bound on pending buffered bytes that throttles the
  producer.
- **Shutdown plan**: ordered, bounded, idempotent teardown sequence with a
  forced-exit deadline.
- **Quota load state**: whether per-model holds were successfully loaded, with
  retry eligibility distinct from "loaded".
- **Encrypted auth session**: the at-rest representation of a Qwen session, plus
  its migration marker.
- **Layer boundary rule**: an allowed dependency direction between modules,
  checked against the real import graph.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A same-origin rebinding mutation (`Origin == Host ==` attacker
  authority) against a default no-key loopback install is rejected, with a test
  that fails on the pre-fix tree.
- **SC-002**: Every existing admin, CORS, CSRF and local-auth test still passes
  unmodified, including the TLS-proxy tolerance case.
- **SC-003**: The default test command exits 0 with no outbound Qwen request, and
  executes all 164 non-live test files (166 total minus 2 live).
- **SC-004**: The 43 previously orphaned assertions run and pass unmodified; a new
  test file is picked up with zero list edits.
- **SC-005**: Total copied/scanned bytes for a 1 MB answer delivered in 1 KB
  deltas grows linearly, asserted by counter instrumentation — not wall-clock.
- **SC-006**: The escape decoder matches native JSON decoding on a table covering
  `\uXXXX`, `\r`, `\/`, `\b`, `\f`, `\t`, `\n`, `\"`, `\\`, a literal
  backslash-n and a Windows path; the current implementation fails that table.
- **SC-007**: Emitted delta bytes are byte-identical before and after the
  performance work across the existing streaming suites.
- **SC-008**: With a throttled consumer, pending buffered bytes per stream stay
  under the declared bound.
- **SC-009**: Recorded teardown order shows HTTP drain strictly before browser
  close; a hung drain exits non-zero within the grace bound.
- **SC-010**: A non-benign error exits non-zero; a genuine teardown error does not;
  a falsy reason is not classified benign.
- **SC-011**: After a failed first quota load, an existing hold is still enforced
  on the next read.
- **SC-012**: Raw DB bytes contain no cleartext cookie or refresh token, existing
  rows migrate without re-login, and POSIX modes are owner-only.
- **SC-013**: A warm account cache issues zero synchronous account-table writes
  per request (down from at least three).
- **SC-014**: Token estimation runs at most once per distinct prompt per attempt.
- **SC-015**: Production retry-delay defaults are unchanged by the test hook.
- **SC-016**: The import-boundary check reports zero domain→presentation edges and
  no strongly connected component larger than one file in the upstream core.
- **SC-017**: `npm run typecheck` and the full mock suite pass after every story,
  with no new suppression comments and no public endpoint or wire-format change.
- **SC-018**: CI fails on a lint violation, a format violation, a high-severity
  dependency advisory, or a broken package build.

## Assumptions

- The default installation is loopback with no `API_KEY`; that convenience is
  preserved for genuine local use and only the *authority* check is added.
- Operators behind a reverse proxy can declare their public hostname; no attempt
  is made to infer trust from forwarded headers.
- The upstream browser transport stays (constitution II). Direct HTTP is only
  considered for endpoints already proven safe, and is out of scope here.
- Performance claims are established by counter instrumentation and micro
  benchmarks, not by live wall-clock runs; no live Qwen account is needed.
- The `server-lifecycle` failure is a test-runner channel problem, not a product
  assertion; it is fixed or documented, never masked.
- Behaviour-preserving refactors (file splits, layer inversions) are validated by
  the existing suites plus the new boundary check, not by new product tests.
- Each story is independently deliverable; US2 is a blocking prerequisite for
  verifying the others, and US1 is the security MVP.
