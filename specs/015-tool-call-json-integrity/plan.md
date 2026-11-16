# Implementation Plan: Tool-Call Arguments JSON Integrity

**Branch**: `015-tool-call-json-integrity` | **Date**: 2026-11-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/015-tool-call-json-integrity/spec.md`

## Summary

The streaming tool-call path forwards raw buffer substrings as `arguments`
(`src/tools/parser.ts:1676-1686`) and, when the arguments-value scan does not
complete, extends that span to the end of the buffer. Invalid JSON escapes such
as `\l` therefore reach the client verbatim, and a second tool call's object can
be appended to the first one. The same invalid escape makes close-tag detection
reject a *correct* close tag (`parser.ts:72-103` → `1154-1165`), which merges two
blocks; recovery then keeps only the first object and the incremental-match
branch (`parser.ts:1567-1578`) withholds the repaired result, so the client keeps
the corrupt text and no auto-retry fires.

The fix makes emission **preventive**: only a prefix of the arguments value that
is provably part of valid JSON may be streamed, normalized by one shared escape
helper that is also used by boundary detection and strict parsing. The buffer-end
fallback is removed, concatenated objects are split with the existing brace
matcher, malformed drops discard their pending deltas, and finalization
reconciles the emitted text against the canonical serialization with a bounded
closing guard. No new dependency, no new configuration, no adapter change.

## Technical Context

**Language/Version**: TypeScript (`typescript ^7.0.2`) on Node.js 22+

**Primary Dependencies**: existing parser and JSON utilities only; no new runtime
dependency

**Storage**: N/A (in-memory parser state per turn)

**Testing**: `node:test` via `tsx`; `npm run typecheck`; `npm run test:mock`
(explicit file list in `package.json:40`, mirrored at `:41`)

**Target Platform**: Windows, macOS, Linux; Docker and standalone binaries
unaffected

**Project Type**: Single TypeScript service (HTTP API + TUI)

**Performance Goals**: added per-chunk work proportional to newly arrived bytes;
no rescanning of the already-emitted prefix (FR-018)

**Constraints**: incremental streaming must be preserved
(`tool-calls-endpoint.test.ts:531`); per-turn cap, dedupe, prose guard and retry
bounds unchanged; already-sent SSE deltas cannot be retracted

**Scale/Scope**: one new helper module, ~6 focused edits in `parser.ts`, 1 edit in
`json.ts`, 1 edit in `instructions.ts`, 2 new test files

## Constitution Check

- **I. Upstream compatibility**: no endpoint, field or wire-format change; only
  the *content* of `arguments` becomes valid JSON. `NOTICE`/README attribution
  untouched. PASS.
- **II. Browser-transport fidelity**: no transport path touched. PASS.
- **III. Account isolation**: parser state is per-request; no shared cache added.
  PASS.
- **IV. Spec-driven**: spec, research, plan, contract, quickstart and tasks are
  produced before implementation; symptom/cause/fix/verification recorded in
  `research.md`. PASS.
- **V. Observability**: counters for escape repair, block split and integrity
  violation; warn-level structured logs with tool name and index; content
  previews stay capped at the existing 2000 chars. PASS.
- **VI. Test-first**: new regression file asserts `JSON.parse(accumulated deltas)`
  — an assertion class no current test makes — and must fail before the fix.
  Typecheck and the full mock suite are gates. PASS.
- **VII. Security**: no new network destination, no secret logging. PASS.
- **VIII. Simplicity**: extends the existing parser; no new module stack, no new
  configuration flag (D6). The behaviour change is a defect fix, not a feature
  toggle, so "default to current behavior" does not apply to the corrupt output
  itself. PASS with the note recorded in Complexity Tracking.
- **IX. Cross-platform**: pure string logic; the Windows drive-letter heuristic is
  preserved and covered by platform-agnostic tests. No path, shell or signal
  change. PASS.
- **X. Silent operation**: no process spawn, no window. PASS.
- **XI. Engineering excellence**: bounded scan and split, fail-closed emission,
  one shared helper instead of duplicated escape logic, small reviewable diffs,
  docs updated with the behaviour. PASS.

## Design

### Step 1 — Shared escape helper (`src/utils/json.ts`)

Extract the escape branch of `sanitizeAndBalance` (`json.ts:22-47`) into an
exported, string-state-aware helper and add `b` and `f` to the valid-escape set.
Keep the existing Windows drive-letter rule (`json.ts:28-38`) so
`json-recovery.test.ts:55` and `jsonFix.test.ts:28` stay green. `sanitizeAndBalance`
calls the helper; behaviour for valid payloads is unchanged.

Contract: `normalizeJsonStringEscapes(input)` is idempotent on already-valid JSON
and prefix-stable when the caller holds back an incomplete trailing escape.

### Step 2 — Strict parsing and boundary detection agree (`src/tools/parser.ts`)

Add an escape-normalized candidate to `parseToolArgumentsStrict`
(`parser.ts:1154-1165`) and to the candidate chain in `tryParseJsonToolPayload`
(`parser.ts:240-266`). This is the *only* change needed for
`closeTagContentIsParseable` to accept a correct close tag whose payload contains
`\l`, which stops the block merge at its source (FR-008).

### Step 3 — Safe-prefix emission gate (`src/tools/parser.ts`)

In `emitIncrementalToolCallDeltas` (`parser.ts:1631-1712`):

1. remove `?? content.length` from `argsEnd` (`1676-1679`);
2. compute a `safeEnd` for the arguments span with a scanner that carries its
   state (offset, in-string, escape-pending) on the incremental call record, so
   each chunk scans only new bytes;
3. hold back a trailing lone `\` or an incomplete `\uXXXX`;
4. normalize invalid escapes inside the emitted slice with the Step 1 helper;
5. advance `emittedArgumentsLength` by the **raw** bytes consumed and append the
   **emitted** text to a per-index ledger.

`tryRecoverIncrementalToolCall` (`parser.ts:1602`) drops the same fallback.
`flush()` must use the same trimmed content as recovery (`parser.ts:2018` vs
`2029`) so the span and the ledger agree.

### Step 4 — Split concatenated objects (`src/tools/parser.ts`)

Extract the per-object loop of `extractUnwrappedToolCalls` (`3225-3262`) into a
shared `splitTopLevelJsonObjects` helper built on `findMatchingClosingBrace`
(`3269-3299`), and call it from `processToolContent` when a block body holds more
than one top-level object. Each object goes through the normal `parseToolCall` →
`finalizeSuccessfulToolCall` path, so cap, dedupe and name resolution apply
unchanged. Objects beyond the bound are recorded as capped drops (FR-009).

### Step 5 — Delta lifecycle hygiene (`src/tools/parser.ts`)

Add `discardPendingToolCallDeltas()` plus an incremental-state reset to the
malformed branch (`parser.ts:2541-2580`), matching every other drop site. This
closes the orphan-delta leak where a dropped `write` block's raw text is delivered
under the next call's index (FR-010).

### Step 6 — Reconciliation and bounded guard (`src/tools/parser.ts`)

In `finalizeSuccessfulToolCall` (`1559-1578`), before flushing:

- if the ledger text is a strict prefix of `JSON.stringify(tc.arguments)`, push a
  final delta with the missing suffix;
- if it diverges, close the ledger text syntactically from the **emitted span**
  via `computeMissingJsonClosingTokens`, add the existing truncation warning,
  increment `toolcalls.integrity_violation`, record a malformed entry and do not
  increment `successfulToolCallsCount`.

`tryHealTruncatedToolCall` (`2851-2889`) computes its closing tokens from the
ledger instead of `this.buffer.substring(argumentsValueStart)` (FR-013).
`decideMissingToolCallRetry` (`tool-call-heuristics.ts:61-88`) is unchanged: an
integrity failure surfaces as malformed, so a turn with no successful call still
retries within the existing bound (FR-014).

### Step 7 — Prompt hardening and observability

`src/tools/instructions.ts:140-145`: add an escaping guideline (backslash must be
`\\`, only `\" \\ \/ \b \f \n \r \t \uXXXX` are legal, Windows paths need doubled
backslashes) and one path-like example. Cache key and eviction unchanged.
Counters: `toolcalls.escape_repaired`, `toolcalls.block_split`,
`toolcalls.integrity_violation`; verbose logs stay behind `TOOLCALL_DEBUG`.

## Project Structure

### Documentation (this feature)

```text
specs/015-tool-call-json-integrity/
├── spec.md
├── research.md
├── plan.md
├── quickstart.md
├── contracts/
│   └── tool-call-arguments.md
└── tasks.md
```

### Source Code (repository root)

```text
src/
├── utils/
│   └── json.ts                  # Step 1: shared escape helper (+ b, f)
├── tools/
│   ├── parser.ts                # Steps 2-6: gate, split, hygiene, reconciliation
│   ├── instructions.ts          # Step 7: escaping guideline + example
│   └── tool-call-heuristics.ts  # unchanged (verified by tests)
└── tests/
    ├── t7-arguments-integrity.test.ts   # incident repro, chunk-size matrix
    └── json-escape-helper.test.ts       # helper table + prefix stability
```

**Structure Decision**: single-project TypeScript layout, unchanged. All work
lands in the two modules that already own tool-call parsing plus one prompt
module; no new runtime directory, no adapter edits (FR-017).

## Verification

1. `npx tsx --test --env-file=.env.test src/tests/t7-arguments-integrity.test.ts`
   — must FAIL on the pre-fix tree (SC-003), pass after.
2. `npx tsx --test --env-file=.env.test src/tests/json-escape-helper.test.ts`
3. Regression set: `parser.test.ts`, `parser-truncated-tool-call.test.ts`,
   `parser-deep-coverage.test.ts`, `t3/t5/t6`, `tool-recovery-t1t2.test.ts`,
   `tool-calls-endpoint.test.ts`, `interaction-flows.test.ts`,
   `unwrapped-tool-calls.test.ts`, `utils-json-full.test.ts`, `jsonFix.test.ts`,
   `json-recovery.test.ts`, `tool-instructions-cache.test.ts`, `anthropic.test.ts`.
4. `npm run typecheck`
5. `npm run test:mock`

See [quickstart.md](quickstart.md) for the exact commands and the expected
before/after observations.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| VIII "default to current behavior" | The current behavior emits invalid JSON; preserving it by default would preserve the incident. No new configuration is added, so the clause on *new configuration* is not engaged. | A `QWEN_TOOL_ARGS_STRICT=0` escape hatch would keep a known-corrupt code path alive as dead code and double the test matrix. |
