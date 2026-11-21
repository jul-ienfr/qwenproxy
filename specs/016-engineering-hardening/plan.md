# Implementation Plan: Engineering Hardening

**Branch**: `016-engineering-hardening` | **Date**: 2026-11-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/016-engineering-hardening/spec.md`

**Evidence base**: [`docs/AUDIT-2026-11-16.md`](../../docs/AUDIT-2026-11-16.md)

## Summary

qwenproxy's hard mechanisms are already correct — epoch mutexes, FIFO leases with
a stale sweep, single-flight externalisation, connection-time DNS pinning, log
redaction, hashed user keys, encrypted account passwords, bounded cooldowns and a
complete stream teardown. What is missing is **bounding** and **verification**.

Four defect families drive this plan:

1. **One critical security hole in the default install** (S1): no inbound `Host`
   authority check, plus a no-key admin fallback, plus an Origin/Host comparison
   that legitimately agrees under DNS rebinding. A hostile web page gets full admin.
2. **Quadratic cost in the streaming hot path** (P1, P2, P4) and no write
   backpressure (P5). P3 is additionally a **correctness** bug: unicode escapes are
   never decoded and escape ordering corrupts literal backslashes.
3. **Unrecoverable state transitions** (R1, R2, R3, R6, R9): crashes swallowed
   without exit, browser closed before draining, a quota hold permanently lost on
   one transient DB error, shutdown with no time bound.
4. **A broken verification gate** (T1–T4): the default suite is red for a
   non-attributable runner-channel reason, 43 green assertions covering the whole
   multi-user security surface never run, and `npm test` reaches the network.

The approach is **gate first, then security, then cost, then reliability, then
boundaries**. No new endpoint, no new protocol, no new runtime dependency, and the
browser transport is untouched.

## Technical Context

**Language/Version**: TypeScript (`typescript ^7.0.2`), Node.js 22+ (measured on
v24.13.0)

**Primary Dependencies**: existing Hono + `@hono/node-server`, better-sqlite3,
patchright, zod. One new **devDependency** for lint/format (D16). No new runtime
dependency.

**Storage**: SQLite via better-sqlite3 (default), optional Redis adapter. This
feature adds an at-rest encryption migration for `qwen_auth_sessions` and tightens
filesystem modes; no schema change beyond the encrypted column values.

**Testing**: `node:test` via `tsx`. Gate repaired in Phase 2: one derived manifest
replacing two hand-maintained 154-path lists; `test` becomes hermetic; live tests
opt-in. Baseline today: **1210 tests, 1209 pass, 1 fail**.

**Target Platform**: Windows 10/11, macOS, Linux; Docker and standalone binaries
must keep working. POSIX mode bits are ignored on Windows — every filesystem
change must succeed there without error.

**Project Type**: single TypeScript service (HTTP API + TUI + optional GUI)

**Performance Goals**: per-chunk streaming work proportional to newly arrived
bytes; one escape-decode pass per chunk; zero synchronous account-table writes on
a warm cache; at most one token estimation per distinct prompt per attempt; a
declared per-stream pending-write bound.

**Constraints**: incremental streaming preserved; spec 015 tool-call integrity
invariants preserved; browser transport preserved (constitution II); emitted delta
bytes byte-identical; no public endpoint or wire-format change; every performance
fix preceded by a failing counter-instrumented measurement.

**Scale/Scope**: 169 production files / 62 896 LOC; 166 test files; 7 user stories;
~68 tasks across 9 phases. Touches `api/server.ts`, `admin/auth.ts`,
`core/auth-identity.ts`, `core/process-guard.ts`, `core/account-model-limits.ts`,
`core/database.ts`, `core/accounts.ts`, `routes/chat/helpers.ts`,
`routes/chat/streaming.ts`, `tools/parser.ts`, `package.json`, CI, plus new test
files and two small scripts.

## Constitution Check

*GATE: passes before Phase 0 research; re-checked after design below.*

- **I. Upstream compatibility and attribution**: no endpoint, field or wire-format
  change. The only newly rejected requests are ones whose `Host` authority is not
  trusted — i.e. requests that should never have been served. `NOTICE` and README
  attribution untouched. The package entry-point change (D15) removes an
  undocumented deep-import capability, not a documented API; see Complexity
  Tracking. **PASS with note.**
- **II. Browser-transport fidelity**: FR-022 forbids changing the upstream
  transport. P10 is explicitly out of scope (research §3). **PASS.**
- **III. Account isolation and credential safety**: this feature *closes* an
  existing violation — cookies and refresh tokens are currently cleartext
  (S2, verified at `database.ts:540/552`). Per-account isolation is unchanged.
  **PASS (improves compliance).**
- **IV. Spec-driven changes**: spec, research, plan, contracts, quickstart and
  tasks produced before implementation; symptom/cause/fix/verification recorded in
  research.md. **PASS.**
- **V. Observability and operability**: new counters and structured logs for
  authority rejections, quota-load retries and honest watchdog reporting; the
  false "recovered" signal is removed (FR-044); `/health` and `/metrics` keep their
  shape. **PASS.**
- **VI. Test-first and regression gates**: Phase 2 repairs the gate *before* any
  behaviour change, so every later failure is attributable. Each story writes its
  failing assertion first. Live tests become opt-in, satisfying "tests MUST not
  require live credentials unless explicitly marked live". **PASS.**
- **VII. Security and least privilege**: the authority check and the loopback
  peer requirement strengthen administrative authentication; no new outbound
  destination; no secret logging. **PASS.**
- **VIII. Simplicity and backward compatibility**: extends the existing stack; no
  second runtime, database or protocol. Three deviations from "default to current
  behavior" are justified in Complexity Tracking. **PASS with tracked deviations.**
- **IX. Cross-platform by default**: the test manifest is computed with `node:fs`
  rather than a shell glob, because PowerShell does not expand globs (D2).
  Filesystem modes are POSIX-only and must no-op cleanly on Windows. Signal
  handling keeps the existing platform posture. **PASS.**
- **X. Silent, non-intrusive operation**: the runner script spawns the existing
  test command with piped stdio and no console window; no new GUI or tray
  behaviour. **PASS.**
- **XI. Engineering excellence**: this epic *is* principle XI — fail closed
  (R1), bound every buffer and timeout (P5, R6), idempotent shutdown (R2, R6),
  never block the event loop (P1, P2, P7), single-responsibility modules and
  enforceable boundaries (A2, A3, A5), small reviewable diffs. **PASS.**

**Re-check after design**: no new violation introduced. The design adds one
devDependency and two small scripts; it removes duplicated lists and duplicated
escape logic. Gate remains PASS.

## Design

### Phase 2 — Repair the verification gate (US2, blocking)

Nothing else is attributable until this lands.

1. Add a manifest script that enumerates `src/tests/*.test.ts` with `node:fs` and
   subtracts a single declared live-file list (D2). Cross-platform by construction.
2. Rewire `package.json`: `test` → mock only; `test:mock` and `test:mock:fast`
   consume the same manifest and differ only in `--test-concurrency`; `test:live`
   stays explicit.
3. Resolve the `server-lifecycle` runner-channel failure per research D3 — in
   order: reproduce, then remove product-stdout interference inside that test,
   then isolate the invocation if needed. Never skip or delete the file.
4. Confirm the 10 previously orphaned files run and their 43 assertions pass
   unmodified.
5. Correct the stale `1211/1211` claim in `specs/README.md`.

**Exit condition**: default command exits 0, hermetic, 164 files executed.

### Phase 3 — Close the admin authority hole (US1, MVP)

1. Derive the trusted-authority set from the bind host plus explicit operator
   configuration; normalise case, IPv6 literals and default ports (D1).
2. Check the authority **before** identity resolution, so the no-key fallback in
   `auth-identity.ts:115-118` is never reached for an untrusted authority.
3. Additionally require a loopback peer address for the no-key legacy path.
4. Keep `rejectCrossOriginMutation` and CSRF validation as defence in depth.
5. Count and log rejections without bodies or credentials.

**Exit condition**: the rebinding test (Origin == Host == attacker authority)
fails on the pre-fix tree and passes after; every existing admin/CORS/CSRF test
stays green, including TLS-proxy tolerance.

### Phase 4 — Make the hot path linear and correct (US3)

Ordered by risk, lowest first, each preceded by its failing measurement (D17):

1. **Escape decoder** (D5): one native decode replaces four ordered replaces.
   Fixes unicode escapes, `\r`, `\/`, `\b`, `\f` and the ordering corruption, and
   cuts four allocations to one. Guarded fallback to the existing parse path.
2. **Delta suffix** (D4): compute from the new bytes; never flatten the
   accumulator. `matchedContent` and `contentLength` unchanged, so deltas stay
   byte-identical.
3. **Backpressure** (D8): await the write, keep the 8 KB / 3 ms micro-buffer and
   the heartbeat, declare and assert the pending-byte bound.
4. **SSE line prefix** (D6): stop re-scanning the consumed prefix.
5. **Parser boundary scan** (D7): only if the benchmark proves super-linear work;
   carry a scan cursor across feeds while preserving every spec 015 invariant.

**Exit condition**: counters linear, escape table matches native decoding, delta
bytes identical, spec 015 suites green.

### Phase 5 — Recoverable state transitions (US4)

1. Reorder teardown: drain first, then browser, then flush, then Redis/SQLite
   (D9). Add one forced-exit deadline; install signal handlers before warmup.
2. Exit non-zero on non-benign errors; narrow the benign classifier to require
   browser/CDP evidence; falsy and empty values are not benign (D10).
3. Set the quota loaded flag only after success; bounded retry; log persistence
   failures (D11). Leave `clearAllModelLimits`'s deliberate flag set alone.
4. Release stream-registry entries, leases and locks on every failure path; clear
   deadline timers in `finally`; do not release the personalization mutex while
   its operation runs; add a bounded registry sweep.

**Exit condition**: recorded teardown order correct; hung drain exits within the
bound; crash exits; failed quota load still enforces the hold.

### Phase 6 — Credentials at rest (US5)

Encrypt cookie, bx tokens and refresh token with the existing AES-256-GCM helper;
migrate cleartext rows once and idempotently using the envelope-format detection
already proven by the password and users migrations; tighten POSIX modes and
no-op cleanly on Windows; surface undecryptable credentials as explicit account
errors instead of empty passwords (D12).

**Exit condition**: raw DB bytes contain no cleartext secret; existing sessions
keep working without re-login.

### Phase 7 — Proportionate per-request work (US6)

Move the reconciliation write behind its throttle (D13, trivial, highest ratio);
materialise the full prompt lazily; memoise token estimation per distinct prompt
per attempt; test length caps before trimming; make telemetry non-blocking; gate
per-request logs; guard the test hook out of production; make the watchdog honest;
bound the half-open pool behaviour; diagnose DB integrity failures; bound caches.

**Exit condition**: zero warm-cache writes, one estimation per prompt, production
retry defaults unaffected by the test hook.

### Phase 8 — Enforceable boundaries (US7)

Add the boundary check first so it fails on today's tree, then invert the
single-edge layer violations cheapest-first (D14), then extract the shared error
taxonomy to break the 10-file SCC. Point the package entry at built output and
declare the public surface (D15). Add lint/format/audit/build CI gates and make
the release non-cancellable (D16). Increase compiler strictness and reduce `any`
without suppression comments. Split large files only where a story needs it.

**Exit condition**: zero domain→presentation edges, no multi-file SCC in the
upstream core, CI fails on each new gate violation.

## Project Structure

### Documentation (this feature)

```text
specs/016-engineering-hardening/
├── spec.md
├── research.md
├── plan.md
├── quickstart.md
├── contracts/
│   ├── admin-request-authority.md
│   └── hot-path-budget.md
└── tasks.md
```

### Source Code (repository root)

```text
scripts/
└── run-tests.mjs                     # Phase 2: derived mock manifest (D2)

src/
├── api/
│   └── server.ts                     # Phases 3, 5: authority gate, teardown order, forced exit
├── admin/
│   └── auth.ts                       # Phase 3: keep Origin/CSRF as defence in depth
├── core/
│   ├── auth-identity.ts              # Phase 3: no-key path requires loopback peer
│   ├── process-guard.ts              # Phase 5: exit policy + narrower classifier
│   ├── account-model-limits.ts       # Phase 5: loaded-flag after success
│   ├── database.ts                   # Phase 6: encrypt at rest, owner-only modes
│   ├── accounts.ts                   # Phases 6, 7: credential errors, write behind throttle
│   ├── stream-registry.ts            # Phase 5: bounded sweep
│   └── watchdog.ts                   # Phase 7: honest recovery reporting
├── routes/chat/
│   ├── helpers.ts                    # Phase 4: suffix without flattening
│   ├── streaming.ts                  # Phase 4: decoder, prefix scan, backpressure
│   ├── account.ts                    # Phase 5: timers, mutex, failure-path release
│   └── index.ts                      # Phases 5, 7: release on failure, lazy prompt
├── tools/
│   └── parser.ts                     # Phase 4: incremental boundary scan (gated on benchmark)
└── tests/
    ├── admin-request-authority.test.ts   # Phase 3: rebinding + trusted-host matrix
    ├── hot-path-budget.test.ts           # Phase 4: counter-instrumented linearity
    ├── stream-escape-decoding.test.ts    # Phase 4: escape table vs native decode
    ├── shutdown-ordering.test.ts         # Phase 5: recorded teardown sequence
    ├── process-guard-exit.test.ts        # Phase 5: exit policy
    ├── quota-load-retry.test.ts          # Phase 5: transient DB failure
    └── auth-session-encryption.test.ts   # Phase 6: raw bytes + migration

package.json                          # Phases 2, 7, 8: scripts, entry point, devDeps
.github/workflows/ci.yml              # Phase 8: gates + non-cancellable release
tsconfig.json                         # Phase 8: strictness
```

**Structure Decision**: single-project TypeScript layout, unchanged. Two new
scripts at most; new modules only where a boundary inversion requires extracting
an existing responsibility. No new runtime directory, no adapter edits, no
protocol surface change.

## Verification

1. `npm run typecheck` — must stay green after every phase.
2. The repaired default test command — must exit 0, hermetic, 164 files.
3. Per-story failing-first assertions, run on the pre-fix tree to prove they fail.
4. Counter-instrumented budget assertions (contracts/hot-path-budget.md).
5. Authority matrix assertions (contracts/admin-request-authority.md).
6. The spec 015 regression set, unchanged, after any parser or streaming edit.
7. `npm audit` and `npm run build` once the CI gates land.

See [quickstart.md](quickstart.md) for exact commands and expected before/after
observations.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| VIII "new configuration MUST default to current behavior" — the authority check rejects requests that today succeed | The requests it rejects are exactly the rebinding attack (S1). Defaulting to current behaviour would preserve a full admin takeover on the default install. The trusted set is derived automatically, so no operator configuration is required for the default or for a bound host; configuration is only needed for a reverse-proxy hostname, which today has no protection at all. | An opt-in `STRICT_HOST_CHECK=1` would leave every existing installation vulnerable by default and double the test matrix, while protecting only operators who already know they need it. |
| VIII "existing clients and scripts MUST keep working" — `npm test` no longer runs live tests | Constitution VI forbids the default gate from requiring live credentials. `test:live` remains available unchanged, so no capability is removed; only the default composition changes. | Keeping live tests in `test` would keep the default gate non-hermetic and quota-consuming, which is the defect being fixed (T3). |
| I/VIII public surface — `main` moves from `src/index.ts` to built output | The published entry point is currently uncompiled internals with no `exports` map, so every deep import is implicitly public and the runtime depends on `tsx` (A4). Declaring the surface is the only way to make it stable. `src` keeps shipping for one release to soften the transition. | Leaving `main` on raw TS keeps an unversioned, unbounded public surface and a production dependency on a TS loader; adding `exports` while keeping `main` on `src` would be contradictory. |
