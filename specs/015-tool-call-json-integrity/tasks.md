---
description: "Task list for 015-tool-call-json-integrity"
---

# Tasks: Tool-Call Arguments JSON Integrity

**Input**: Design documents from `specs/015-tool-call-json-integrity/`

**Prerequisites**: plan.md, spec.md, research.md, contracts/tool-call-arguments.md, quickstart.md

**Tests**: Required by constitution VI and spec SC-003 — every new assertion must
fail on the pre-fix tree before its implementation task lands.

**Organization**: Grouped by user story; US1 alone is the MVP (no unparseable
arguments ever reach a client).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1–US4 from spec.md
- Line numbers refer to the pre-fix tree and will drift as tasks land.

## Phase 1: Setup

**Purpose**: Establish a green baseline so any later failure is attributable.

- [x] T001 Run `npm run typecheck` and the quickstart.md §3 regression set on the untouched tree; save output to `.tmp/015-baseline.log`. Record any pre-existing failure in research.md before proceeding. No source change.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: One shared escape helper, used by every consumer. Blocks ALL stories.

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

- [x] T002 [P] Write failing helper tests in `src/tests/json-escape-helper.test.ts`: table of `\l`, `\a`, `\x`, `\u00zz`, `\b`, `\f`, `C:\Users`, `https://`, `\"`, trailing lone backslash; idempotence on already-valid JSON; prefix stability; Windows drive-letter rule preserved (FR-006, FR-007, contract I5).
- [x] T003 Extract and export `normalizeJsonStringEscapes` from the escape branch of `sanitizeAndBalance` in `src/utils/json.ts:22-47`; add `b` and `f` to the valid-escape set; keep the drive-letter rule at `json.ts:28-38`; `sanitizeAndBalance` delegates to the helper (depends on T002).
- [x] T004 Add an escape-normalized candidate to `parseToolArgumentsStrict` (`src/tools/parser.ts:1154-1165`) and to the candidate chain of `tryParseJsonToolPayload` (`src/tools/parser.ts:240-266`); keep the strict chain — never `robustParseJSON` (FR-008, depends on T003).

**Checkpoint**: Helper green; a correct close tag whose payload contains `\l` is accepted as a block boundary.

---

## Phase 3: User Story 1 - Every delivered tool call parses (Priority: P1) 🎯 MVP

**Goal**: The concatenation of emitted `arguments` deltas always passes `JSON.parse`, for any chunking.

**Independent Test**: `t7-arguments-integrity.test.ts` — incident fixtures × chunk sizes {1, 2, 7, 64, single}, no client and no network.

### Tests for User Story 1

- [x] T005 [US1] Write failing incident repro in `src/tests/t7-arguments-integrity.test.ts` (inline fixtures, node:test conventions per research.md §5): accumulate `toolCallDeltas[i].function.arguments` per index and assert `JSON.parse`; fixtures for `\l` in a markdown content value, a string ending with a backslash before its closing quote (quote-parity shift), an incomplete `\u00` at a chunk boundary, a genuinely truncated payload, and the chunk-size matrix equality (FR-001–FR-005, contracts I1–I4). Confirm the emission assertions fail before T007.

### Implementation for User Story 1

- [x] T006 Register `src/tests/t7-arguments-integrity.test.ts` and `src/tests/json-escape-helper.test.ts` in the explicit file lists of `package.json:40` (`test:mock`) and `package.json:41` (`test:mock:fast`) (depends on T002, T005; single file — not parallel).
- [x] T007 [US1] Implement the safe-prefix emission gate in `emitIncrementalToolCallDeltas` (`src/tools/parser.ts:1631-1712`): remove `?? content.length` at `1676-1679`; carry scanner state (offset, in-string, escape-pending) on the incremental call record so each chunk scans only new bytes (FR-018); hold back a trailing lone backslash and incomplete `\uXXXX` (FR-005); normalize the emitted slice with the T003 helper; advance `emittedArgumentsLength` by raw bytes consumed and append emitted text to a per-index ledger (depends on T003, T005).
- [x] T008 [US1] Remove the same buffer-end fallback in `tryRecoverIncrementalToolCall` (`src/tools/parser.ts:1602`) and align the `flush()` delta content with the recovery-trimmed content (`parser.ts:2018` vs `2029`) so span and ledger agree (depends on T007).
- [x] T009 [US1] Implement reconciliation and the bounded divergence guard in `finalizeSuccessfulToolCall` (`src/tools/parser.ts:1559-1578`): strict-prefix ledger → emit the missing suffix delta; divergence → close the ledger text via `computeMissingJsonClosingTokens`, add the existing truncation warning, increment `toolcalls.integrity_violation`, record a malformed entry, do not increment `successfulToolCallsCount` (FR-011, FR-012, FR-014, contracts I6–I7; depends on T007).
- [x] T010 [US1] Compute healing tokens from the emission ledger instead of the full remaining buffer in `tryHealTruncatedToolCall` (`src/tools/parser.ts:2851-2889`, span at `2864-2867`) (FR-013, depends on T009).
- [x] T011 [US1] Checkpoint: run t7 + helper + quickstart.md §3 regression set; verify SC-001, SC-002 (escape fixtures), SC-003.

**Checkpoint**: MVP — no unparseable arguments string can reach a client.

---

## Phase 4: User Story 2 - Two calls stay two calls (Priority: P1)

**Goal**: A write block followed by an edit block yields two calls; nothing is swallowed or cross-contaminated.

**Independent Test**: Two-block fixture with `\l` in the first block → two indexes, each arguments string parses to its own object.

### Tests for User Story 2

- [x] T012 [US2] Extend `src/tests/t7-arguments-integrity.test.ts`: two-block fixture (assert two indexes, no `oldString`/`newString` in `emitted(0)`, no `content` in `emitted(1)`); one block holding two concatenated top-level objects (split, or explicit capped drop — never silent truncation); malformed-then-valid fixture (exactly one index, no orphan bytes from the dropped block) (FR-002, FR-009, FR-010, contracts I2, I8). Must fail before T013/T014.

### Implementation for User Story 2

- [x] T013 [US2] Extract `splitTopLevelJsonObjects` from the per-object loop of `extractUnwrappedToolCalls` (`src/tools/parser.ts:3225-3262`) over `findMatchingClosingBrace` (`3269-3299`); call it from `processToolContent` when a block body holds multiple top-level objects; route each object through `parseToolCall` → `finalizeSuccessfulToolCall` so cap, dedupe and name resolution apply unchanged; record over-bound objects as capped drops; increment `toolcalls.block_split` (FR-009, depends on T004, T012).
- [x] T014 [US2] Add `discardPendingToolCallDeltas()` plus an incremental-state reset to the malformed branch of `processToolContent` (`src/tools/parser.ts:2541-2580`), matching every other drop site (`1526`, `1551`, `2092`, `2229`, `2532`) (FR-010, depends on T012).
- [x] T015 [US2] Checkpoint: run t7 + `t3/t5/t6` + `interaction-flows.test.ts` + `unwrapped-tool-calls.test.ts` + `tool-calls-endpoint.test.ts`; verify SC-002 end to end.

**Checkpoint**: US1 + US2 — the incident payload yields two valid calls.

---

## Phase 5: User Story 3 - Deterministic escape repair (Priority: P2)

**Goal**: Boundary detection, strict parsing, recovery and emission agree on escape validity.

**Independent Test**: One payload evaluated by all four consumers yields the same verdict and value.

- [x] T016 [US3] Add cross-path agreement tests to `src/tests/json-escape-helper.test.ts` (same raw payload through close-tag detection, `parseToolArgumentsStrict`, recovery and the emission gate; valid payloads byte-unchanged; `\b`/`\f` preserved); run `utils-json-full.test.ts`, `jsonFix.test.ts`, `json-recovery.test.ts` (FR-006–FR-008, contract I5; depends on T003, T004, T007).

**Checkpoint**: No duplicated notion of JSON validity remains.

---

## Phase 6: User Story 4 - Operable and less likely (Priority: P3)

**Goal**: Counters, logs and prompt hardening.

**Independent Test**: Counters increment on the incident fixtures; generated instructions contain the escaping rule.

- [x] T017 [P] [US4] Add the JSON string escaping guideline (legal escapes, doubled backslashes, Windows-path example) to `src/tools/instructions.ts:140-145`; check `src/tests/tool-instructions-cache.test.ts` (robustness-rules test at `:61`) and update it only if it enumerates the guidelines (FR-015).
- [x] T018 [P] [US4] Assert observability in `src/tests/t7-arguments-integrity.test.ts`: `toolcalls.escape_repaired`, `toolcalls.block_split`, `toolcalls.integrity_violation` increment on the right fixtures; warn-level integrity record carries tool name and index; previews stay capped at 2000 chars; verify `/metrics` exposes all three and the unchanged stream summary still surfaces lost calls as malformed/capped (FR-016, SC-006 as restated in research.md §7; depends on T009, T013).

**Checkpoint**: All four stories independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [x] T019 Add the SC-005 linear-scan assertion to `src/tests/t7-arguments-integrity.test.ts`: counter-instrumented scanner work on a 200 KB streamed arguments value stays linear in bytes (FR-018; no wall-clock benchmark).
- [x] T020 Run full gates: `npm run typecheck` and `npm run test:mock` (SC-004); compare against `.tmp/015-baseline.log`.
- [x] T021 Documentation: set spec.md Status to Implemented, update the 015 row and status note in `specs/README.md`, execute quickstart.md end to end, and note post-fix line-number drift in research.md.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (T001)**: no dependencies.
- **Foundational (T002–T004)**: depends on T001 — BLOCKS all stories.
- **US1 (T005–T011)**: depends on Foundational. MVP.
- **US2 (T012–T015)**: depends on Foundational; T013 also uses T004's boundary acceptance. Independently testable.
- **US3 (T016)**: depends on T003, T004, T007 (verifies their agreement).
- **US4 (T017–T018)**: T017 depends only on Foundational; T018 depends on T009, T013.
- **Polish (T019–T021)**: depends on all desired stories.

### Within Each Story

- Tests written and failing before implementation (T002→T003, T005→T007, T012→T013/T014).
- T006 (package.json) is sequential: it is the only task editing that file.
- T007 before T008/T009; T009 before T010.

### Parallel Opportunities

- T002 and T005 touch different new test files — parallelizable once Foundational ordering allows (T005 still needs T004 to isolate gate failures).
- T017 and T018 touch different files (`instructions.ts` vs t7) — parallel.
- US2 and US4's T017 can proceed alongside US1 after Foundational.

## Implementation Strategy

### MVP First

1. T001 baseline → 2. T002–T004 helper → 3. T005–T011 (US1) → 4. STOP and validate: no unparseable arguments on any fixture/chunking → 5. ship.

### Incremental Delivery

US1 (parseability) → US2 (no lost/merged calls) → US3 (agreement) → US4 (observability + prevention). Each step keeps the previous suites green.

## Notes

- No new configuration flag (research.md D6); no adapter edits (FR-017).
- Already-sent SSE deltas cannot be retracted: the gate is preventive, the guard is bounded.
- Commit per task or logical group, Conventional Commits (`fix:`, `test:`, `docs:`).
- Avoid: rescanning the emitted prefix per chunk, a second escape regex outside the shared helper, widening the strict chain to `robustParseJSON`.
