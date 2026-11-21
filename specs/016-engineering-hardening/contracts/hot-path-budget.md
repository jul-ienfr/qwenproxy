# Contract: Hot-Path Work Budget

**Feature**: 016-engineering-hardening · **Story**: US3, US6 · **Findings**: P1–P9, P11

**Purpose**: make "faster" falsifiable. Each budget below is a **counted** quantity,
not a wall-clock target, following the precedent set by spec 015 SC-005. A shared CI
runner is too noisy to distinguish O(n) from O(n²); counting bytes and passes is
deterministic and reviewable.

## Measurement rules

1. Every budget is asserted by a counter instrumented in the test, not by timing.
2. Each budget test **must fail on the pre-fix tree** before its fix lands.
3. Counters are test-only instrumentation or existing metrics; no production log
   volume is added to satisfy a budget.
4. Correctness is asserted alongside cost: a budget that passes while changing
   output bytes is a failure (see B9).
5. No budget may be satisfied by changing the upstream transport (constitution II,
   spec FR-022).

## Budgets

### B1 — Delta suffix computation is constant per chunk

**Quantity**: bytes copied while computing the 32-character suffix.

**Before**: for a strictly incremental answer of N bytes delivered in fixed-size
deltas, total copied bytes grows with N² — the accumulator is a cons-string and
the suffix slice flattens it (`routes/chat/helpers.ts:15` reached from `:82`).

**After**: total copied bytes is O(N); per-chunk suffix cost is bounded by the
32-character window regardless of answer length.

**Assertion**: feed 10 KB, 100 KB and 1 MB answers in 1 KB deltas; the ratio of
total copied bytes to answer size stays bounded (does not grow with size).

### B2 — Exactly one escape-decode pass per chunk

**Quantity**: decode passes over the captured content body.

**Before**: 4 sequential replace passes (`routes/chat/streaming.ts:2015-2019`).

**After**: 1 native decode.

**Assertion**: count passes for a chunk containing escapes; assert 1.

### B3 — Escape decoding is exactly native JSON semantics

**Quantity**: correctness, not cost — but it gates B2.

**Table** (each case asserts equality with a native JSON string decode of the same
body): unicode escape; carriage-return escape; solidus escape; backspace escape;
form-feed escape; tab escape; newline escape; quote escape; backslash escape; a
literal backslash followed by the letter n; a Windows drive path; a surrogate pair;
an empty body; a body with no escapes.

**Before**: the unicode, carriage-return, solidus, backspace and form-feed cases
fail (never decoded); the literal-backslash-n and Windows-path cases fail
(ordering corruption).

**After**: all cases pass.

### B4 — Cumulative line parsing does not re-scan the consumed prefix

**Quantity**: bytes scanned per chunk while extracting the content field.

**Before**: proportional to the whole line, which in cumulative mode contains the
entire answer so far (`streaming.ts:2011-2013`, anchored at both ends).

**After**: proportional to the newly arrived bytes.

**Assertion**: cumulative stream of 10 KB → 1 MB; total scanned bytes is O(N).

### B5 — Pending client-write bytes are bounded

**Quantity**: maximum pending buffered bytes for one stream.

**Before**: unbounded with a slow consumer — the write is not awaited
(`streaming.ts:1238`), so the producer never slows.

**After**: stays at or below a declared bound; the producer is throttled instead
of the heap growing.

**Assertion**: producer emits faster than a throttled consumer reads; assert the
observed maximum never exceeds the bound, and assert the stream still completes
with identical bytes.

**Preserved**: the 8 KB / 3 ms coalescing window and the 15 s heartbeat. Removing
them to satisfy B5 is a contract violation (it would regress TTFB and syscall
count).

### B6 — Tool-block boundary scanning is incremental

**Quantity**: bytes scanned plus parse attempts per feed.

**Before** (◐ auditor-reported, ○ not re-verified): the whole accumulated buffer is
lower-cased, scanned and re-parsed at every feed while inside a tool block
(`tools/parser.ts:2232`).

**After**: bounded per feed; the already-scanned prefix is not re-examined.

**Gate**: this budget is **conditional**. The benchmark must first demonstrate
super-linear work on the current tree. If it does not, the fix task is dropped and
finding P4 is downgraded in the audit — the budget is not asserted vacuously.

**Correctness gate**: every spec 015 invariant must still hold (parseable
arguments, no merged or lost calls, prefix stability, bounded retries). B6 may
never be satisfied at the cost of FR-020.

### B7 — Zero synchronous account-table writes on a warm cache

**Quantity**: synchronous writes issued by account reconciliation per request.

**Before**: at least 3 — the reconciliation write runs before its throttle check
(`core/accounts.ts:145-150` precedes `:155-156`) and reconciliation is reached at
least three times per request.

**After**: 0 while the cache is warm; exactly one reconciliation when the env
account set actually changes.

**Assertion**: instrument the write; issue N requests within the sync interval;
assert 0 writes. Then change the env set and assert exactly one reconciliation,
and that a removed account does not resurrect.

### B8 — One token estimation per distinct prompt per attempt

**Quantity**: estimations for the same prompt text within one attempt.

**Before**: 3–4 (truncation, limit assertion twice, context meter).

**After**: 1, with all consumers agreeing on the value.

**Assertion**: count estimations for a single attempt; assert 1; assert
truncation, limits and context-meter report the same number.

### B9 — Output bytes are unchanged

**Quantity**: correctness gate over B1, B2, B4, B5, B6.

**Assertion**: for cumulative, strictly incremental and mixed streams, and for
chunk sizes 1, 2, 7, 64 and single-feed, the emitted delta bytes are byte-identical
to the pre-fix behaviour. The existing streaming and spec 015 suites run
unmodified.

**Rationale**: every cost fix in this contract is a pure representation change.
Any byte difference means the fix is wrong, not that the budget is met.

## Explicitly not budgeted here

- **Upstream transport cost (P10)**: the Chromium round trip is mandated by
  constitution II. Measuring it is fine; changing it is out of scope.
- **Retry amplification (P6)**: the composed budgets are bounded in practice by
  verified guards (single `chat_in_progress` escalation, anti-bot rotation capped
  at 1, no mid-stream recovery after first emit). Unifying them changes failover
  semantics and needs its own spec with live evidence.
- **Wall-clock latency targets**: no p95/p99 threshold is asserted as a gate. p99
  and event-loop delay are added as **observability** so regressions are visible,
  not as pass/fail criteria on shared runners.
