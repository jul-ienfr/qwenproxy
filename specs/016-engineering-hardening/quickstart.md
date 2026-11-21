# Quickstart: Verifying Engineering Hardening

**Feature**: 016-engineering-hardening

**Audience**: a reviewer who wants to confirm each claim without a Qwen account,
without outbound network, and without reading the implementation.

All commands are PowerShell-compatible and run from the repository root. Nothing
here requires live credentials; `test:live` is deliberately never invoked.

## 1. Prerequisites

```powershell
node --version          # expect v22+ (baseline measured on v24.13.0)
npm ci                  # reproducible install from the tracked lockfile
```

No `.env` is needed. The mock suite supplies its own timings via `.env.test`.

## 2. Baseline — capture before touching anything (T001)

```powershell
npm run typecheck
npm audit
npm run test:mock
```

**Expected on the pre-fix tree** (`a9da064`):

| Command | Result |
| --- | --- |
| `typecheck` | clean, no output |
| `npm audit` | 0 vulnerabilities |
| `test:mock` | **1210 tests, 1209 pass, 1 fail**, ~250 s |

The single failure is `src/tests/server-lifecycle.test.ts` with
`Unable to deserialize cloned data due to invalid or unsupported version.` — every
frame is inside `node:internal/test_runner/runner`. It is **not** an assertion.

Confirm it is a runner-channel problem, not a product defect:

```powershell
npx tsx --test --env-file=.env.test src/tests/server-lifecycle.test.ts
```

**Expected**: 3/3 pass in under a second. Same file, same code, different context.

Confirm the coverage hole (T007):

```powershell
npx tsx --test --test-concurrency=1 --env-file=.env.test `
  src/tests/account-proxy.test.ts src/tests/apply-upstream-usage.test.ts `
  src/tests/mutex-epoch.test.ts src/tests/stale-stream-slot-sweeper.test.ts `
  src/tests/timezone-ascii.test.ts src/tests/tool-call-heuristics.test.ts `
  src/tests/user-auth.test.ts src/tests/user-quota.test.ts `
  src/tests/users.test.ts src/tests/users-migration.test.ts
```

**Expected**: 43 tests, 43 pass. These are the specs 001/002 regression suites that
the default gate never runs.

Save all of the above to `.tmp/016-baseline.log`.

## 3. US2 — the gate is green, hermetic and complete

After T002–T008:

```powershell
npm test
```

**Expected**: exits 0; no outbound Qwen request; **164 files** executed (166 minus
the 2 declared live files); the 10 previously orphaned files appear in the run.

Prove the single source of truth (FR-010):

```powershell
Set-Content -LiteralPath src/tests/zz-manifest-probe.test.ts -Value @'
import { test } from "node:test";
import assert from "node:assert/strict";
test("manifest probe", () => assert.equal(1, 1));
'@
npm test
Remove-Item -LiteralPath src/tests/zz-manifest-probe.test.ts
```

**Expected**: the probe runs with **no edit to `package.json`**. Before the fix it
would have been silently ignored.

Prove the variants share one manifest (FR-012):

```powershell
npm run test:mock:fast
```

**Expected**: same file set, only concurrency differs.

## 4. US1 — the rebinding mutation is refused (MVP)

```powershell
npx tsx --test --env-file=.env.test src/tests/admin-request-authority.test.ts
```

**Expected before T012**: the two critical cases fail — untrusted `Host` with a
matching `Origin`, and untrusted `Host` with no `Origin`.

**Expected after**: all contract I1–I10 assertions pass.

Then prove nothing legitimate broke (SC-002):

```powershell
npx tsx --test --env-file=.env.test `
  src/tests/admin-dashboard.test.ts src/tests/admin-session.test.ts `
  src/tests/login-throttle.test.ts src/tests/local-auth.test.ts `
  src/tests/cors-headers.test.ts src/tests/user-auth.test.ts `
  src/tests/tenant-isolation.test.ts
```

**Expected**: all green, **unmodified** — including "origin checks tolerate a TLS
proxy but reject another host" and "legacy no-key mutations still reject a
cross-origin browser".

## 5. US3 — cost is linear and decoding is correct

```powershell
npx tsx --test --env-file=.env.test src/tests/stream-escape-decoding.test.ts
npx tsx --test --env-file=.env.test src/tests/hot-path-budget.test.ts
```

**Expected before T018/T019**: the escape table fails on unicode, carriage return,
solidus, backspace, form feed, literal backslash-n and Windows-path cases; the
suffix-copy counter grows super-linearly with answer size; decode passes = 4.

**Expected after**: escape table matches native decoding on every case; copied and
scanned bytes are O(N); decode passes = 1; pending write bytes stay under the
declared bound with a throttled consumer.

Prove output did not change (B9 / SC-007) — the spec 015 regression set:

```powershell
npx tsx --test --env-file=.env.test `
  src/tests/t7-arguments-integrity.test.ts src/tests/json-escape-helper.test.ts `
  src/tests/parser.test.ts src/tests/parser-deep-coverage.test.ts `
  src/tests/parser-truncated-tool-call.test.ts src/tests/t3-close-tag-escape.test.ts `
  src/tests/t5-tool-cap.test.ts src/tests/t6-missing-quote-array-close.test.ts `
  src/tests/tool-recovery-t1t2.test.ts src/tests/tool-calls-endpoint.test.ts `
  src/tests/interaction-flows.test.ts src/tests/unwrapped-tool-calls.test.ts `
  src/tests/delta.test.ts src/tests/stream-retry.test.ts src/tests/chat-logic-full.test.ts
```

**Expected**: all green, unmodified. Any byte difference is a defect, not a
performance win.

## 6. US4 — state transitions are recoverable

```powershell
npx tsx --test --env-file=.env.test `
  src/tests/shutdown-ordering.test.ts src/tests/process-guard-exit.test.ts `
  src/tests/quota-load-retry.test.ts src/tests/server-lifecycle.test.ts `
  src/tests/process-guard-and-resilience.test.ts
```

**Expected after**: recorded teardown shows HTTP drain strictly before browser
close; a hung drain exits non-zero within the grace bound; a non-benign error exits
non-zero while a genuine teardown error does not; a falsy reason is not benign;
after a failed first quota load an existing hold is still enforced.

## 7. US5 — no cleartext secret on disk

```powershell
npx tsx --test --env-file=.env.test `
  src/tests/auth-session-encryption.test.ts src/tests/auth-session-persistence.test.ts `
  src/tests/auth-session-refresh-preservation.test.ts src/tests/accounts-security.test.ts
```

**Expected after**: raw DB bytes contain no cleartext cookie, refresh token or bx
token; the round-trip still returns them; a cleartext row migrates once without
forcing re-login; POSIX modes are owner-only and the Windows path succeeds without
error.

## 8. US6 — per-request work is proportionate

```powershell
npx tsx --test --env-file=.env.test `
  src/tests/hot-path-budget.test.ts src/tests/config-current.test.ts `
  src/tests/daily-usage.test.ts src/tests/overload-detector.test.ts `
  src/tests/quota-detector.test.ts src/tests/watchdog-ram.test.ts `
  src/tests/watchdog-rss.test.ts src/tests/metrics-prometheus.test.ts
```

**Expected after**: zero synchronous account-table writes on a warm cache (down
from at least three); one token estimation per distinct prompt per attempt;
production retry-delay defaults unchanged by the test hook; the watchdog reports
no recovery when it took no action; `/health` and `/metrics` shapes unchanged.

## 9. US7 — boundaries and gates are enforced

```powershell
node scripts/check-boundaries.mjs
npm run lint
npm run build
npm audit --audit-level=high
```

**Expected before T055–T059**: the boundary check reports `core → routes`,
`core → tui`, `services → root` and a 10-file strongly connected component.

**Expected after**: zero domain→presentation edges, no multi-file SCC in the
upstream core, lint and build clean, audit clean. Confirm CI fails when a
violation is reintroduced (SC-018).

## 10. Full gates (T066)

```powershell
npm run typecheck
npm test
npm run build
npm audit
```

**Expected**: all clean. Compare with `.tmp/016-baseline.log`.

## 11. Before / after summary

| Claim | Before | After |
| --- | --- | --- |
| Default test command | runs live tests, needs credentials | hermetic, mock only |
| Mock suite result | 1210 tests, 1 fail (runner channel) | exits 0 |
| Files executed by the gate | 154 of 166 | 164 of 166 (all non-live) |
| Specs 001/002 regression suites | never run in CI | 43 assertions run and pass |
| Adding a test file | edit two 154-path lists | nothing to edit |
| Rebinding mutation, no-key loopback | accepted (full admin) | 403, no state change |
| Escape decoding | 4 passes; unicode/CR/solidus/BS/FF never decoded; order corrupts literal backslashes | 1 pass, matches native decoding |
| Delta suffix cost, 1 MB answer | ~quadratic copies | O(N), 32-byte window |
| Slow consumer | unbounded pending writes | under declared bound |
| Warm-cache account writes | ≥ 3 synchronous per request | 0 |
| Token estimations per prompt | 3–4 | 1 |
| Teardown order | browser closed before drain | drain first, bounded exit |
| Non-benign crash | logged, process keeps serving | logged, exits non-zero |
| Transient quota-load failure | hold lost for process lifetime | retried, hold enforced |
| Qwen cookie / refresh token | cleartext, world-readable dir | encrypted, owner-only |
| Domain → presentation imports | present | zero, mechanically checked |
| Upstream core import cycle | 10-file SCC | none |
| Published entry point | raw TS, `tsx` in production | built output, declared surface |
| CI gates | typecheck + mock | + lint, format, audit, build |

## 12. Troubleshooting

**`server-lifecycle` still fails after T006.** Do not skip it. Re-run T005 to
establish whether the failure is order-dependent, then apply D3 step 3 (isolate the
invocation) and record the cause in research.md. A green gate obtained by hiding a
file is a contract violation (FR-013).

**A budget test passes on the pre-fix tree.** The counter is measuring the wrong
thing. Fix the instrumentation before writing the fix — an assertion that never
failed proves nothing (FR-022).

**The parser benchmark shows linear work.** Drop T025 and downgrade finding P4 in
the audit. Do not implement an incremental cursor for a defect that measurement
could not confirm (research D7).

**A legitimate reverse-proxy dashboard returns 403 after US1.** Declare its
hostname in the trusted-host setting (contract I4). Do not widen trust from
`X-Forwarded-Host` — that reintroduces the vulnerability through another header.

**Delta bytes differ after a performance fix.** The fix is wrong. B9 is a
correctness gate, not a tolerance; revert and re-derive the representation change.
