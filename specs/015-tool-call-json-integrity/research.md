# Phase 0 Research: Tool-Call Arguments JSON Integrity

**Feature**: 015-tool-call-json-integrity | **Date**: 2026-11-16

All findings below were verified by reading the current tree. Line numbers refer
to the pre-fix state and will drift once the fix lands.

## 1. Symptom

Client error:

```text
Invalid input for tool write
JSON parsing failed: Text: {"filePath":"C:\\Users\\...\\app-supervision.md","content":"... ;\leur migration ..."}{"filePath":"...\\checklist.md","oldString":"...","newString":"..."}
Error message: JSON Parse error: Invalid escape character l
```

Two defects in one string:

1. `\l` is not a legal JSON escape (legal: `\" \\ \/ \b \f \n \r \t \uXXXX`).
2. Two complete arguments objects are concatenated, so even with the escape fixed
   the string is not a single JSON value.

## 2. Root cause chain

| # | Mechanism | Evidence |
|---|---|---|
| 1 | The incremental delta path forwards **raw buffer substrings** as `arguments`, with no `JSON.parse` anywhere. | `src/tools/parser.ts:1631-1712`, substring at `1680-1686` |
| 2 | When the arguments-value scan does not complete, the span end **falls back to the end of the buffer**, so the raw span swallows the next object, envelope keys and stray tags. | `parser.ts:1676-1679` (`snapshot.argumentsValueEnd ?? content.length`) |
| 3 | The scanners accept `\` + *any* character, so `\l` never breaks the scan, but a string ending `\"` flips quote parity and the scan never completes. | `parser.ts:796-821`, `823-869` (esp. `837-838`, `862-863`, `868`), `113-160` |
| 4 | Close-tag detection requires the prefix to parse with **plain `JSON.parse` + narrow typo repairs that never fix escapes**, so a *correct* first close tag is rejected; the merged `{obj1}{obj2}` prefix is not parseable either; the function then returns null and the block stays open. | `parser.ts:72-103`, `179-193`, `240-266`, `1154-1165` |
| 5 | At finalization, `matchesIncrementalCall` flushes the **raw** deltas and returns **without pushing the repaired object**, so the recovery result never reaches the client. | `parser.ts:1559-1578` |
| 6 | Recovery keeps only the **first** object (truncation to last balanced index / first brace match), so the second call is silently lost. | `src/utils/json.ts:296-341`, `parser.ts:3041-3099`, `2583-2713` |
| 7 | Because one call "succeeded", the auto-retry decision returns no-retry; the loss is log-only. | `src/tools/tool-call-heuristics.ts:61-88` (guard at `76`), `src/routes/chat/streaming.ts:2834-2859` |
| 8 | The malformed-drop branch does **not** discard pending deltas (every other drop site does), so orphan raw deltas are flushed by the *next* successful call. | `parser.ts:2541-2580` vs `1526`, `1551`, `2092`, `2229`, `2532` |
| 9 | Truncation healing computes closing tokens from the **full remaining buffer**, not the emitted span, and cannot fix an escape already streamed. | `parser.ts:2851-2889` (`2864-2867`), `src/utils/json.ts:130-147` |
| 10 | The only invalid-escape handler in the codebase lives in `sanitizeAndBalance` and its `validEscapes` list **omits `b` and `f`**; the delta path never calls it. | `src/utils/json.ts:22-47` (list at `23`) |
| 11 | The injected tool contract never mentions backslash escaping or Windows paths; sample arguments are `{"key":"value1"}`. | `src/tools/instructions.ts:125-145`, samples `84-86`, `102-104` |

**Conclusion**: the model produced malformed JSON (expected, unavoidable), and
the proxy's streaming path forwarded it verbatim while its recovery path silently
discarded the repair. The client-visible corruption is created by the proxy, not
by the transport.

## 3. Which emission paths are affected

| Path | Arguments source | Safe today? |
|---|---|---|
| Non-streaming chat | `JSON.stringify(tc.arguments)` — `streaming.ts:411`, `654` | Yes (object always parsed) |
| Streaming chat, complete call | `JSON.stringify` — `streaming.ts:1491`, `2407`, `2780` | Yes |
| Streaming chat, incremental delta | `delta.function.arguments` verbatim — `streaming.ts:1450-1452`, `2366-2368`, `2763-2765` | **No** |
| Anthropic non-stream | `JSON.parse` with `{raw:...}` fallback — `anthropic/translate.ts:326-346` | Yes (degrades) |
| Anthropic stream | `partial_json` verbatim — `anthropic/translate.ts:519-529` | **No** (inherits parser deltas) |
| Gemini | accumulates then `parseToolArguments` — `gemini/translate.ts:752-768`, `1046-1085` | Parses, but silently truncates concatenation |

Fixing the parser fixes all downstream adapters; no adapter change is required
(FR-017).

## 4. Decisions

### D1 - Preventive emission gate, not retroactive repair

SSE deltas cannot be retracted. Validating only at finalization is therefore
insufficient. Emission must be restricted to a **safe prefix** of the arguments
value: a prefix whose scan never meets an invalid escape and never ends inside an
incomplete escape. Normalization is applied at the emission boundary so it is
prefix-stable (FR-004).

*Rejected*: buffer the whole call and emit once parsed — loses incremental
streaming, which `tool-calls-endpoint.test.ts:531` explicitly asserts.

### D2 - Remove the `content.length` fallback

The span end must come from the arguments-value scanner only. When the end is
unknown, emit up to the scanner's safe-prefix end, which is inside the value by
construction. This alone eliminates the cross-object leak (FR-002, FR-003).

*Rejected*: keep the fallback and validate the concatenated text — validation
would fail after the bytes were already sent.

### D3 - One shared escape helper

Extract the escape logic from `sanitizeAndBalance` into an exported helper in
`src/utils/json.ts` (add `b`, `f`) and use it from `parseToolArgumentsStrict`,
`tryParseJsonToolPayload` and the emission gate. This makes close-tag detection
and streaming agree (FR-006, FR-008) and removes the duplicated notion of JSON
validity.

*Rejected*: a second regex in `repairCommonMalformedToolJson` — a regex cannot
respect string state and would corrupt code payloads (the T6 class of bugs).

### D4 - Split concatenated objects inside a block

Reuse the existing brace-matching splitter (`extractUnwrappedToolCalls` /
`findMatchingClosingBrace`, `parser.ts:3225-3299`) by extracting a shared helper
instead of writing a second scanner. Bound the split by the per-turn cap and the
dedupe key so a runaway model cannot multiply calls (FR-009).

### D5 - Reconciliation plus a bounded guard

Track the exact emitted arguments text per index. At finalize:

- emitted text is a strict prefix of `JSON.stringify(tc.arguments)` → emit the
  remaining suffix (covers held-back tails and normalization differences);
- emitted text diverges → close it syntactically from the **emitted span**, add
  the existing truncation warning, count `toolcalls.integrity_violation`, and do
  not increment the success counter.

With D1–D3 in place the divergence branch should be unreachable for escape
issues; it remains as defence in depth for genuine truncation and must be tested
by forcing it (FR-011, FR-012, FR-013).

*Rejected*: dropping the call entirely on divergence — the client already has an
open tool call at that index and would hang.

### D6 - No new configuration

The current behaviour is a defect, so the fix is on by default. Constitution VIII
requires *new configuration* to be optional; adding a flag to restore the buggy
path would add dead code. Existing `TOOLCALL_DEBUG` gates the verbose logs.

## 5. Test conventions to follow

- Runner: `node:test` via `tsx`; single file
  `npx tsx --test --env-file=.env.test src/tests/<file>.test.ts`.
- Gates: `npm run typecheck`, `npm run test:mock` (explicit file list in
  `package.json:40`, mirrored in `test:mock:fast` at `:41`).
- Incident-named files are the established pattern:
  `parser-truncated-tool-call.test.ts`, `t3-close-tag-escape.test.ts`,
  `t5-tool-cap.test.ts`, `t6-missing-quote-array-close.test.ts`,
  `tool-recovery-t1t2.test.ts`.
- No existing test asserts `JSON.parse(accumulated deltas)`. That assertion class
  is the regression gate for this feature.
- Suites that must stay green: `parser.test.ts`,
  `parser-truncated-tool-call.test.ts`, `parser-deep-coverage.test.ts`,
  `t3/t5/t6`, `tool-recovery-t1t2.test.ts`, `tool-calls-endpoint.test.ts`,
  `interaction-flows.test.ts`, `unwrapped-tool-calls.test.ts`,
  `utils-json-full.test.ts`, `jsonFix.test.ts`, `json-recovery.test.ts`,
  `tool-instructions-cache.test.ts`, `anthropic.test.ts`.

## 6. Open risks

- **Prefix stability of normalization**: doubling an invalid escape is stable
  only if a trailing lone backslash is never emitted before its next character
  arrives. FR-005 makes this explicit and it must be tested at chunk size 1.
- **Windows drive-letter heuristic**: `sanitizeAndBalance` double-escapes
  `\n \r \t` after a `X:` prefix (`json.ts:28-38`). The shared helper must keep
  that behaviour so `json-recovery.test.ts:55` and `jsonFix.test.ts:28` stay green.
- **Per-chunk cost**: `inspectIncrementalJsonToolObject` already rescans the whole
  content each chunk. The gate must carry its scan state on the incremental call
  record so the added work is amortized linear (FR-018, SC-005).

## 7. Post-implementation notes (2026-11-16)

**Line-number drift**: all `parser.ts` / `json.ts` line references in §§2–4 and in
tasks.md refer to the pre-fix tree (parser.ts 3299 lines). After the fix parser.ts
grew past 3643 lines; the emission gate, reconciliation, split helper and boundary
fallback moved. Locate by symbol, not line: `normalizeJsonStringEscapes` /
`normalizeJsonEscapeAt` (src/utils/json.ts), `emitIncrementalToolCallDeltas`,
`reconcileIncrementalArguments`, `closeDivergentLedger`,
`splitTopLevelJsonObjects`, `findToolEndOutsideJsonString` (src/tools/parser.ts).

**Verification (quickstart.md executed end to end)**:
- §1 pre-fix repro: 9/13 assertions failed on the untouched tree
  (`.tmp/015-prefix-fail.log`) — SC-003 satisfied.
- §2 fix: `t7-arguments-integrity.test.ts` + `json-escape-helper.test.ts` 20/20
  (`.tmp/015-checkpoint.log`).
- §3 regression set: 160/160, EXIT 0 (`.tmp/015-regression.log`).
- §4 gates: `npm run typecheck` EXIT 0; `npm run test:mock` 1208/1208, EXIT 0
  (`.tmp/015-fullgate.log`). Baseline before any change: typecheck 0, regression
  160/160 (`.tmp/015-baseline.log`).
- §5 observability: `toolcalls.escape_repaired`, `toolcalls.block_split`,
  `toolcalls.integrity_violation` asserted in the FR-016 test; the I7 divergence
  guard warns with tool name + index and is not counted as a success.

**Test-design correction**: the US3 cross-path test originally fed two identical
blocks; dedupe (existing, intended behaviour) collapsed them to one call. The
second block now differs by `filePath` so the boundary assertion is meaningful.

**Boundary acceptance for concatenated objects**: `findToolEndOutsideJsonString`
also accepts a close tag whose prefix splits into >1 complete top-level objects
(`splitTopLevelJsonObjects`), so a merged `{env1}{env2}` block is split at the real
close tag instead of being truncated to the first object at flush.

**SC-006 restated (contradiction with FR-017 removed)**: the original SC-006 asked
for all three counters in `/metrics` *and* the stream summary, and T018 repeated
it. Verified against the tree: the summary is emitted from
`src/routes/chat/streaming.ts` and carries only `malformedCount` / `cappedCount`
(non-stream and stream paths). Adding `escape_repaired` / `block_split` /
`integrity_violation` there would be an adapter edit, which FR-017 forbids. SC-006
and T018 were therefore restated to match the parser-only constraint: all three
counters are countable from `/metrics`, and the unchanged summary still makes
every lost call visible — an integrity violation is recorded as a malformed entry
(`closeDivergentLedger` → `recordMalformedToolCall`), an over-cap split object as a
capped drop. No acceptance behaviour was weakened and no code changed; only the
self-contradictory wording was corrected. If richer per-turn split reporting is
wanted later, it needs its own spec that relaxes FR-017.

**Split-branch hardening (post-implementation review)**: reading the merged-object
branch revealed two defects. (1) A failed object's pending incremental deltas were
not discarded, so a subsequent successful sibling could flush them under its index
(I1/I8 leak) or trip the divergence guard on a same-name sibling. (2) When every
object failed (`handled === 0`), control fell through to the whole-block path,
which re-recorded the entire block as malformed (double counting). Fix: a shared
`abortIncrementalToolCall()` (discard pending deltas + `disabled`/`startEmitted=false`)
is called before recording a failed or undeclared object; each object also gets a
`lastChanceRecoverToolCall` fallback; the branch now returns unconditionally,
restoring the lead-in only when nothing was emitted. The malformed drop branch
reuses the same helper. Three new T7 tests cover broken+edit, broken+same-name
sibling, and two broken objects (exactly two malformed entries).
Verified after hardening (`.tmp/015-splitfix.log`): typecheck EXIT 0; t7 + helper
23/23 EXIT 0; regression set 160/160 EXIT 0; `test:mock` 1211/1211 EXIT 0.
