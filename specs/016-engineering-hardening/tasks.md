---
description: "Task list for 016-engineering-hardening"
---

# Tasks: Engineering Hardening

**Input**: Design documents from `specs/016-engineering-hardening/`

**Prerequisites**: plan.md, spec.md, research.md, contracts/admin-request-authority.md,
contracts/hot-path-budget.md, quickstart.md

**Evidence base**: [`docs/AUDIT-2026-11-16.md`](../../docs/AUDIT-2026-11-16.md)

## Implementation status (updated 2026-11-17)

| Phase | Tasks | Status |
| --- | --- | --- |
| 1 — Baseline | T001 | **Done** (`.tmp/016-baseline.log`) |
| 2 — Test gate (US2) | T002–T008 | **Done** — derived manifest, hermetic `npm test`, lifecycle failure diagnosed as intermittent runner-channel and hardened, 10 orphaned suites restored, README baseline corrected |
| 3 — Admin authority (US1) | T009–T015 | **Done** — rebinding matrix refused, loopback peer requirement, counter + redacted log, `.env.*` ignored |
| 4 — Hot path (US3) | T016–T026 | **Done** — B1/B2/B3/B4/B5/B6 all asserted by counters; parser boundary scan confirmed super-linear then made incremental; extractor equivalence suite added |
| 5 — State transitions (US4) | T027–T034, T036 | **Done** — drain-before-browser, bounded forced exit, handlers before warmup, fatal-error exit policy with strict classification, quota load retry, registry sweep |
| 5 — residual | T035 | **Done** — acquire-deadline timer disarmed on the failure path; the personalization mutex is now awaited before release (research.md §5.28) |
| 6 — Credentials at rest (US5) | T037–T042 | **Done** — cookie, bx tokens and refresh token encrypted with the existing AES-256-GCM envelope; one-shot idempotent migration of cleartext rows; data dir 0700 / DB file 0600 on POSIX (no-op on Windows); undecryptable credentials now exclude the account and log without the value |
| 7 — Per-request cost (US6) | T043–T048, T050–T053 · **T049 declined** | **Complete.** B7 asserted by `account-sync-writes.test.ts` (T043); B8 by the token memo (T046/T047). T045 is resolved with evidence in research.md §5.17: a lazy getter would be forced unconditionally by `account.ts:928`, so the two real wins (byte-length short-circuit, non-allocating emptiness test) were delivered instead. T049 declined with evidence in §5.13 |
| 8 — Boundaries (US7) | T054, T055–T058 (partial), T060, T062, **T063 (partial)** | **Partial** — `scripts/check-boundaries.mjs` with a pinned ratchet: 8 forbidden edges found, **8 fixed**, **0 tracked**; the 10-file SCC shrank to 7 and no longer spans layers, and import cycles are now tracked separately (2 known, pinned); ratchet test + CI gates (audit/boundaries/build, non-cancellable release); `main`/`exports`/`types` → built output, `tsx` in devDependencies; **`noUnusedLocals` enabled** after removing 45 dead symbols (research.md §5.19–5.20). T061 done — Biome added as a devDependency with a documented rule subset (27 errors fixed, 3 real defects found), wired as a CI gate; Remaining: `noUncheckedIndexedAccess` (636 errors), T064 |
| 9 — Polish | T065–T068 | **Done.**


**Tests**: Required by constitution VI and by spec SC-001/SC-005/SC-006 — every new
assertion must fail on the pre-fix tree before its implementation task lands.

**Organization**: Grouped by user story. **US2 is a blocking prerequisite** (the
gate must be green and complete before any other fix is attributable); **US1 is the
security MVP**.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: different files, no dependency — can run in parallel
- **[Story]**: US1–US7 from spec.md
- Line numbers refer to the pre-fix tree (`a9da064`) and will drift as tasks land.

## Phase 1: Setup

**Purpose**: record the measured baseline so every later delta is attributable.

- [ ] T001 Run `npm run typecheck`, `npm run test:mock`, and the 10 orphaned files in isolation on the untouched tree; save output to `.tmp/016-baseline.log`. Confirm the recorded numbers match research.md §1 (1210 tests / 1209 pass / 1 fail; 43/43 orphans). No source change.

---

## Phase 2: Foundational — US2 Test gate (Priority: P1, BLOCKING)

**Purpose**: one hermetic, complete, green gate. Blocks ALL other stories.

**⚠️ CRITICAL**: no behaviour change lands until this phase is green.

- [ ] T002 [P] [US2] Write failing manifest assertions in `src/tests/test-manifest.test.ts`: derived set equals every `src/tests/*.test.ts` minus the declared live files; all 10 currently orphaned files are present; a newly created fixture file is picked up with no list edit; the fast variant differs only by concurrency (FR-010–FR-012, SC-003/SC-004).
- [ ] T003 [US2] Create `scripts/run-tests.mjs`: enumerate with `node:fs` (no shell glob — PowerShell does not expand them), declare the two live files in one exported constant, accept a concurrency argument, spawn the existing `tsx --test --env-file=.env.test` with the computed paths, piped stdio and `windowsHide: true` (FR-008–FR-012; constitution IX/X; depends on T002).
- [ ] T004 [US2] Rewire `package.json:39-42`: `test` → mock only; `test:mock` and `test:mock:fast` → the script with concurrency 1 and 2; `test:live` unchanged and explicit. Single file — not parallel (depends on T003).
- [ ] T005 [US2] Reproduce the `server-lifecycle` runner-channel failure deterministically per research.md D3 step 1: two full runs plus the file alongside its immediate list neighbours. Record in research.md whether it is order-dependent. No fix yet (FR-013).
- [ ] T006 [US2] Resolve the failure in D3 order: silence product stdout inside `src/tests/server-lifecycle.test.ts` so the child's reporting channel is not shared; if it persists, isolate that file into its own runner invocation and record the cause. **Never skip, delete or weaken the file** (FR-013; depends on T005).
- [ ] T007 [US2] Verify the 10 previously orphaned files execute in the new gate and their 43 assertions pass **unmodified**: `users`, `users-migration`, `user-auth`, `user-quota`, `account-proxy`, `mutex-epoch`, `stale-stream-slot-sweeper`, `tool-call-heuristics`, `apply-upstream-usage`, `timezone-ascii` (FR-011, SC-004; depends on T004, T006).
- [ ] T008 [US2] Correct the stale `test:mock` 1211/1211 claim at `specs/README.md:20` to the measured numbers, noting the runner-channel cause (FR-014; depends on T007).

**Checkpoint**: default command exits 0, performs no outbound Qwen request, executes 164 files. Every later failure is now attributable.

---

## Phase 3: US1 — Admin authority (Priority: P1) 🎯 MVP

**Goal**: a hostile web page cannot drive the dashboard, even when Origin and Host agree.

**Independent Test**: `admin-request-authority.test.ts` — rebinding matrix, no network, no Qwen account.

- [ ] T009 [P] [US1] Write failing authority assertions in `src/tests/admin-request-authority.test.ts` covering contract I1–I10: the four Origin variants against an untrusted Host; trusted-set derivation with no config; forwarded headers never widening trust; the normalisation table; loopback-peer requirement for the no-key path; retained Origin/CSRF rejection; adapter self-fetch smoke; counter and redacted log; wildcard bind. Confirm I1 rows 1–2 fail before T012 (FR-001–FR-006, SC-001).
- [ ] T010 [US1] Add trusted-authority derivation (new `src/core/trusted-hosts.ts`, reusing `isLoopbackHost`/`isWildcardBind` from `core/local-auth.ts`): loopback authorities on the listening port plus the concrete bound host; normalise case, IPv6 brackets and default ports; never read a request header (FR-002/FR-003, contract I3/I5; depends on T009).
- [ ] T011 [US1] Add the optional trusted-host setting to `src/core/config.ts`, defaulting to the derived set so no operator action is needed for a default or bound-host install (FR-002, contract I4; depends on T010).
- [ ] T012 [US1] Mount the authority gate in `src/api/server.ts` **before** identity resolution and before `authenticateAdminRequest`, so `auth-identity.ts:115-118` is never reached for an untrusted authority (FR-001, contract I1; depends on T010, T011).
- [ ] T013 [US1] Require a loopback peer address for the no-key legacy path at `src/admin/auth.ts:190-198`; keep `rejectCrossOriginMutation` and `validateCsrf` intact as defence in depth (FR-004/FR-005, contract I6/I7; depends on T012).
- [ ] T014 [US1] Add the rejection counter to `core/metrics.ts` and one warn-level structured log carrying authority and method only — no body, credential, cookie or query string; do not enumerate the trusted set in the response (FR-006, contract I9; depends on T012).
- [ ] T015 [P] [US1] Extend `.gitignore` to cover `.env.*` while keeping `.env.example` and `.env.test` allowed; verify with `git check-ignore -v` (FR-007).

**Checkpoint**: MVP — the rebinding mutation is refused; all seven existing admin/auth/CORS suites pass unmodified (SC-002).

---

## Phase 4: US3 — Linear, bounded, correct hot path (Priority: P1)

**Goal**: per-chunk work proportional to new bytes; every legal escape decoded correctly; writes bounded.

**Independent Test**: counter-instrumented budgets (contracts/hot-path-budget.md), no network.

Ordered lowest-risk first. Each fix is preceded by its failing measurement (FR-022).

- [ ] T016 [P] [US3] Write the failing escape table in `src/tests/stream-escape-decoding.test.ts`: every case in contract B3, each asserted equal to a native JSON string decode. Confirm the unicode, carriage-return, solidus, backspace, form-feed, literal-backslash-n and Windows-path cases fail before T018 (FR-018, SC-006).
- [ ] T017 [P] [US3] Write failing budget assertions in `src/tests/hot-path-budget.test.ts` for B1 (suffix copies at 10 KB / 100 KB / 1 MB in 1 KB deltas) and B2 (decode passes per chunk). Confirm both fail before T018/T019 (FR-015/FR-018, SC-005).
- [ ] T018 [US3] Replace the four ordered replaces at `src/routes/chat/streaming.ts:2015-2019` with one native decode of the captured body, guarded so a pathological capture falls back to the existing whole-line parse instead of throwing mid-stream (FR-018, contract B2/B3, research D5; depends on T016, T017).
- [ ] T019 [US3] Compute the suffix without flattening the accumulator in `src/routes/chat/helpers.ts` (`buildDeltaResult:10-17`, strictly-incremental branch `:82`): derive from the new bytes, fall back to a bounded slice of the old suffix only when the delta is shorter than the window. Keep `matchedContent` and `contentLength` unchanged (FR-015/FR-016, contract B1/B9, research D4; depends on T017).
- [ ] T020 [P] [US3] Write the failing backpressure assertion (contract B5): throttled consumer, assert observed maximum pending bytes exceeds the declared bound before the fix, and that output bytes are identical (FR-021, SC-008).
- [ ] T021 [US3] Await the client write in `flushWrites` (`src/routes/chat/streaming.ts:1238`) or chain a drain promise; declare the per-stream pending-byte bound; **preserve** the 8 KB / 3 ms micro-buffer and the 15 s heartbeat (FR-021, contract B5, research D8; depends on T020).
- [ ] T022 [P] [US3] Write the failing cumulative-prefix scan counter (contract B4): total scanned bytes must be O(N) across 10 KB → 1 MB (FR-017).
- [ ] T023 [US3] Extract the content field without re-scanning the consumed prefix at `src/routes/chat/streaming.ts:2011-2013`, reusing the T018 decoder; keep the whole-line parse as fallback (FR-017, contract B4, research D6; depends on T018, T022).
- [ ] T024 [P] [US3] Write the parser boundary benchmark (contract B6): bytes scanned plus parse attempts per feed for a large tool payload, with and without a literal close tag inside a JSON string. **Decision gate**: if it does not demonstrate super-linear work, drop T025 and downgrade finding P4 in the audit (FR-019/FR-022, research D7).
- [ ] T025 [US3] Conditional on T024: carry a scan cursor (offset, in-string, escape-pending) across feeds for block-boundary detection in `src/tools/parser.ts` (`feed` boundary call at `:2232`), avoiding the whole-buffer lower-case and repeated prefix parses. Preserve every spec 015 invariant (FR-019/FR-020, contract B6; depends on T024).
- [ ] T026 [US3] Checkpoint: assert B9 byte-identical deltas for cumulative, incremental and mixed streams at chunk sizes 1/2/7/64/single; run the spec 015 regression set (`t7-arguments-integrity`, `json-escape-helper`, `parser`, `parser-deep-coverage`, `parser-truncated-tool-call`, `t3/t5/t6`, `tool-recovery-t1t2`, `tool-calls-endpoint`, `interaction-flows`, `unwrapped-tool-calls`) plus `delta`, `stream-retry`, `chat-logic-full` (FR-016/FR-020, SC-007).

**Checkpoint**: counters linear, escape table green, delta bytes identical, spec 015 intact.

---

## Phase 5: US4 — Recoverable state transitions (Priority: P2)

**Goal**: drain before teardown, exit on real crashes, survive transient DB failure, release every resource on failure.

- [ ] T027 [P] [US4] Write failing ordering assertions in `src/tests/shutdown-ordering.test.ts`: recorded call sequence shows HTTP drain strictly before browser close; a hung drain exits non-zero within the grace bound; repeated `stopServer()` stays idempotent (FR-023/FR-024, SC-009).
- [ ] T028 [US4] Reorder `cleanupServerResources` in `src/api/server.ts:1039-1115`: drain `server.close()` first, then `closeAllPlaywright()`, then flush thread state, then Redis, then SQLite. Update the misleading comment at `:1079-1081` (FR-023, research D9; depends on T027).
- [ ] T029 [US4] Add one forced-exit deadline to `handleSignal` (`src/api/server.ts:1117-1123`) that exits non-zero exactly once; keep `stopServer()` idempotent for the repeated calls in `server-lifecycle.test.ts:102-103/105` (FR-024; depends on T028).
- [ ] T030 [US4] Install signal handlers before account warmup begins (currently `src/api/server.ts:1401-1403`), so a signal during warmup still cleans up (FR-025; depends on T029).
- [ ] T031 [P] [US4] Write failing exit-policy assertions in `src/tests/process-guard-exit.test.ts`: non-benign error exits non-zero; genuine Playwright/CDP teardown does not; falsy reason, empty object and a generic "Connection closed" from non-browser code are not benign (FR-026/FR-027, SC-010).
- [ ] T032 [US4] In `src/core/process-guard.ts`: exit non-zero after logging a non-benign error (`:57-83`); narrow `isBenignTeardownError` (`:29-45`) and `isPlaywrightAlreadyClosedMessage` (`:10-27`) to require browser/CDP evidence; remove the falsy and empty-object shortcuts. Extend `process-guard-and-resilience.test.ts`, never weaken it (FR-026/FR-027, research D10; depends on T031).
- [ ] T033 [P] [US4] Write failing retry assertions in `src/tests/quota-load-retry.test.ts`: first load fails, an existing hold is still enforced on the next read; a persistence failure is logged without secrets (FR-028/FR-029, SC-011).
- [ ] T034 [US4] In `src/core/account-model-limits.ts`: set `loadedFromDb` only after a successful `loadModelLimits()` (`ensureLoaded:42-46`); allow a bounded retry; replace the silent catches at `:69/:90/:118/:130/:140` with redacted logs. **Leave the deliberate flag set at `:136` in `clearAllModelLimits` unchanged** (FR-028/FR-029, research D11; depends on T033).
- [ ] T035 [US4] Release every resource on the failure path: add `removeStream` and lease release to the catch in `src/routes/chat/index.ts:731-759`; move the acquire-deadline timer out of the `try` and clear it in `finally` (`src/routes/chat/account.ts:1620/1705/1834-1855`); do not release the personalization mutex while `syncPromise` is still running (`account.ts:1541-1551/1590-1593`) (FR-030/FR-031).
- [ ] T036 [US4] Add a bounded sweep to `src/core/stream-registry.ts` so an abandoned entry cannot retain headers/cookies indefinitely; align the bound with the existing lease max duration and keep the timer `unref`'d and stoppable (FR-032).

**Checkpoint**: teardown order asserted, crash exits, quota hold survives a transient failure, no leaked timer or registry entry.

---

## Phase 6: US5 — Credentials at rest (Priority: P2)

**Goal**: no cleartext Qwen secret on disk; owner-only access; migration without re-login.

- [ ] T037 [P] [US5] Write failing assertions in `src/tests/auth-session-encryption.test.ts`: raw DB bytes contain no cleartext cookie, refresh token or bx token; round-trip returns them; a pre-existing cleartext row migrates once and idempotently; POSIX modes are owner-only and the Windows path succeeds without error (FR-033–FR-035, SC-012).
- [ ] T038 [US5] Encrypt cookie, bx tokens and refresh token in `saveAuthSession` (`src/core/database.ts:504-556`, binds at `:540/:552`) using the existing AES-256-GCM helper in `core/crypto-utils.ts`; decrypt on read in `getValidAuthSession` (`:558-608`) (FR-033, research D12; depends on T037).
- [ ] T039 [US5] Migrate existing cleartext rows once, idempotently, detecting cleartext by the existing ciphertext envelope rather than a new schema flag, following the pattern proven by the password and users migrations; log a count, never a value (FR-034; depends on T038).
- [ ] T040 [US5] Create the data directory owner-only and the DB file owner-read/write (`src/core/database.ts:45`, currently mode 0755); align `paths.ts:ensureDataDirs`; on Windows the call must succeed without error and without weakening ACLs (FR-035, constitution IX; depends on T038).
- [ ] T041 [US5] Surface an undecryptable credential as an explicit account error and exclude the account from rotation, instead of an empty password (`src/core/accounts.ts:246-250`) or a raw-ciphertext proxy URL (`:254-257`); log without the value (FR-036).
- [ ] T042 [US5] Checkpoint: run `auth-session-persistence`, `auth-session-refresh-preservation`, `accounts-security`, `users-migration` unmodified; confirm no re-login is forced and the refresh-token preservation behaviour is intact.

**Checkpoint**: raw bytes clean, migration transparent, modes correct per platform.

---

## Phase 7: US6 — Proportionate per-request work (Priority: P3)

**Goal**: remove blocking and repeated per-request work; make operability signals honest.

- [ ] T043 [P] [US6] Write the failing write-count assertion (contract B7): N requests within the sync interval issue zero synchronous account-table writes; an env-set change issues exactly one reconciliation and a removed account does not resurrect (FR-037, SC-013).
- [ ] T044 [US6] Move the reconciliation `DELETE` behind its throttle check in `src/core/accounts.ts:141-156` (write at `:145-150`, throttle at `:155-156`). Highest impact/effort ratio in the epic (FR-037, research D13; depends on T043).
- [ ] T045 [US6] Materialise the full prompt lazily in `src/routes/chat/index.ts:263-268`, only when a replay or limit check needs it; assert the upstream payload is unchanged for thread-native delta continuations (FR-038).
- [ ] T046 [P] [US6] Write the failing estimation-count assertion (contract B8): one estimation per distinct prompt per attempt, with truncation, limits and context-meter agreeing (FR-039, SC-014).
- [ ] T047 [US6] Memoise token estimation per distinct prompt text within an attempt (`src/utils/context-truncation.ts:25-93` and its callers `context.ts:166`, `prompt-limits.ts:56`, `account.ts:1366/1610/1713`); bound the memo (FR-039; depends on T046).
- [ ] T048 [P] [US6] Evaluate the length cap before trimming in `src/utils/overload-detector.ts:39-42` and `src/utils/quota-detector.ts:92-93`, so a long cumulative answer is rejected without an O(n) copy (FR-040).
- [ ] T049 [P] [US6] Make telemetry non-blocking: batch or defer the per-turn upsert in `src/core/daily-usage.ts:111-127` (callers `streaming.ts:2976/937`); it is observability only and never throttles (FR-041).
- [ ] T050 [P] [US6] Gate per-request logs behind the configured level (`src/routes/chat/index.ts:171-173/366-368`, `account.ts:651/672/686/1302`); keep `/health` and `/metrics` shape unchanged (FR-042).
- [ ] T051 [US6] Guard the test hook out of production in `src/core/config.ts:123-124` so `TEST_MOCK_QWEN_AUTH` cannot shrink production retry-delay defaults; report the condition when it is set outside a test runtime; document the variable (FR-043, SC-015).
- [ ] T052 [US6] Make operability signals honest and bounded: `core/watchdog.ts:167-169` either performs a bounded real stream-recovery action or reports that none was taken; `core/account-manager.ts:287-297/337-348` behaves as a bounded half-open breaker when the whole pool is in cooldown; `core/database.ts:109-120` diagnoses integrity failures with an actionable message; `cache/memory-cache.ts` gains a size bound in addition to its TTL (FR-044–FR-047).
- [ ] T053 [P] [US6] Correct `.env.example` drift against `core/config.ts` (`PLAYWRIGHT_MAX_ACTIVE_CONTEXTS`, `IDLE_CONTEXT_TTL`, `HEADERS_TIMEOUT`, `QWEN_FIRST_CHUNK_TIMEOUT`) and document every supported variable including the test hook (FR-054).

**Checkpoint**: zero warm-cache writes, one estimation per prompt, production timing unaffected by the test hook, no false recovery signal.

---

## Phase 8: US7 — Enforceable boundaries (Priority: P3)

**Goal**: make the module graph and the quality gates mechanically checked.

- [ ] T054 [P] [US7] Add `scripts/check-boundaries.mjs` (relative-import graph + Tarjan, as used for the audit) with an allowed-direction rule set, plus a test asserting it **fails on the current tree** for `core → routes`, `core → tui` and `services → root` (FR-048, SC-016).
- [ ] T055 [US7] Invert the single `core → routes` edge (1 versus 104 the other way) by moving the shared type or injecting the dependency; boundary check must lose that violation (FR-048; depends on T054).
- [ ] T056 [US7] Invert the single `core → tui` edge (1 versus 25) the same way (FR-048; depends on T054).
- [ ] T057 [P] [US7] Invert the single-edge helper cycles `core → utils` and `utils → tools` (FR-048; depends on T054).
- [ ] T058 [US7] Invert the remaining single-edge inversions: `services → root`, `api → tui`, `admin → api`, `root → tui` (FR-048; depends on T054).
- [ ] T059 [US7] Break the 10-file SCC by extracting the shared error taxonomy out of `src/api/error-classifier.ts` and `src/api/error-helpers.ts` into the domain layer, so `services/*` and `routes/upload.ts` no longer import upward. Each extracted unit must be importable in isolation; `error-classification`, `protocol-errors`, `adapter-stream-errors`, `retry-policy` and `oss-upload` stay green (FR-049, research D14; depends on T055–T058).
- [ ] T060 [US7] Point `main`/`exports` at built output, declare the public surface explicitly, move `tsx` to devDependencies, keep shipping `src` for one release as a transition; add a package smoke test that imports the entry point without `tsx` (FR-050, research D15, plan Complexity Tracking).
- [ ] T061 [US7] Add one lint+format tool as a **devDependency** with config and `lint`/`format` scripts; verify it installs cleanly on Windows, macOS and Linux with the existing TypeScript version (FR-051, research D16).
- [ ] T062 [US7] Add CI gates for lint, format, `npm audit --audit-level=high` and `npm run build`; set `cancel-in-progress: false` for the release path so a tag push and `npm publish` cannot be split (`.github/workflows/ci.yml:9-11`, `:258-265`) (FR-051, SC-018).
- [ ] T063 [US7] Increase compiler strictness in `tsconfig.json` (`noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `noFallthroughCasesInSwitch`) and reduce the 480 `any` occurrences without adding a single suppression comment; typecheck must stay green (FR-052).
- [ ] T064 [US7] Split large files only where a story already required touching them, one responsibility per extracted module, as small reviewable diffs; no public endpoint or wire-format change (FR-053).

**Checkpoint**: zero domain→presentation edges, no multi-file SCC in the upstream core, CI fails on each new gate violation.

---

## Phase 9: Polish & Cross-Cutting

- [ ] T065 [P] Add p99 to the percentile helper in `src/benchmarks/proxy-baseline.ts` and event-loop delay sampling; observability only, not a gate (audit T7, contract "not budgeted").
- [ ] T066 Run full gates: `npm run typecheck`, the repaired default test command, `npm audit`, `npm run build`; compare against `.tmp/016-baseline.log` (SC-017/SC-018).
- [ ] T067 Documentation: set spec.md Status, add the 016 row and status note to `specs/README.md`, fill research.md §5 with post-fix line-number drift and final counters, update `docs/AUDIT-2026-11-16.md` where a finding was fixed or downgraded (notably P4 if T024 dropped T025).
- [ ] T068 Execute quickstart.md end to end on the final tree and record the before/after observations.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (T001)**: none.
- **US2 Foundational (T002–T008)**: depends on T001 — **BLOCKS every other story**.
- **US1 (T009–T015)**: depends on US2. Security MVP.
- **US3 (T016–T026)**: depends on US2. Independent of US1.
- **US4 (T027–T036)**: depends on US2. Independent of US1/US3.
- **US5 (T037–T042)**: depends on US2. Independent.
- **US6 (T043–T053)**: depends on US2. T047 benefits from T045 but does not require it.
- **US7 (T054–T064)**: depends on US2; T059 should follow the behaviour stories so the graph moves after behaviour is proven.
- **Polish (T065–T068)**: depends on all delivered stories.

### Within Each Story

- Tests written and failing before implementation: T002→T003, T009→T012, T016/T017→T018/T019, T020→T021, T022→T023, T024→T025, T027→T028, T031→T032, T033→T034, T037→T038, T043→T044, T046→T047, T054→T055.
- `package.json` is edited by T004, T060 and T061 — **sequential**, never parallel.
- `src/api/server.ts` is edited by T012, T028, T029, T030 — **sequential**.
- `src/routes/chat/streaming.ts` is edited by T018, T021, T023 — **sequential**.
- T024 is a decision gate: T025 exists only if the benchmark proves the defect.

### Parallel Opportunities

- After US2: US1, US3, US4, US5, US6 can proceed concurrently — they touch disjoint files except the shared ones listed above.
- Within US3: T016, T017, T020, T022, T024 are separate new test files.
- Within US6: T048, T049, T050, T053 touch unrelated files.
- Within US7: T057 is independent of T055/T056/T058.

## Implementation Strategy

### MVP First

1. T001 baseline → 2. T002–T008 gate green and complete → 3. T009–T015 (US1) →
4. **STOP and validate**: the rebinding mutation is refused and every existing
admin suite is green → 5. ship. This alone removes the only remote-compromise
defect in the audit.

### Incremental Delivery

US2 (verifiable) → US1 (safe) → US3 (fast and correct) → US4 (recoverable) →
US5 (encrypted at rest) → US6 (proportionate) → US7 (enforceable). Each step keeps
every previous suite green and is independently demonstrable.

### Quick-Win Extraction

If only a few hours are available, the highest ratio items are T044 (write behind
throttle), T018 (one decode pass, also a correctness fix), T019 (suffix without
flatten), T034 (quota flag) and T004 (hermetic default command). All are small
diffs with disproportionate effect.

## Notes

- No new runtime dependency; one lint/format devDependency (T061).
- The upstream browser transport is never modified (FR-022, constitution II).
- Retry-budget unification and wholesale god-file reorganisation are out of scope
  (research.md §3).
- Commit per task or logical group, Conventional Commits (`fix:`, `perf:`, `test:`,
  `chore:`, `docs:`).
- Avoid: skipping `server-lifecycle.test.ts` to make the gate green; asserting a
  budget with wall-clock timing; satisfying a budget by changing output bytes;
  widening the trusted-authority set from a request header; adding `@ts-ignore`
  to silence the stricter compiler settings.
