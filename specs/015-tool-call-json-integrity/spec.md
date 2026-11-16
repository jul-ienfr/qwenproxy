# Feature Specification: Tool-Call Arguments JSON Integrity

**Feature Branch**: `015-tool-call-json-integrity`

**Created**: 2026-11-16

**Status**: Implemented

**Input**: Incident 2026-11-16 — a coding-agent client rejected a tool call with
`Invalid input for tool write / JSON parsing failed ... JSON Parse error: Invalid
escape character l`. The `arguments` string the proxy delivered contained
(a) an invalid JSON escape `\l` inside a markdown `content` value and (b) two
concatenated JSON objects: a `write` arguments object immediately followed by an
`edit` arguments object, with no envelope and no separator. The proxy is expected
to never hand a client arguments that fail `JSON.parse`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Every delivered tool call parses (Priority: P1)

A coding agent (Kilo, opencode, Claude Code, Cline) streams a turn in which the
model writes a file whose content contains Windows paths, backslashes and
markdown. Whatever the model emits, the arguments the client accumulates for each
tool call are valid JSON and describe exactly one call.

**Why this priority**: This is the incident. An unparseable `arguments` string
aborts the client's tool execution, loses the whole turn's work and forces the
user to re-ask. It is also the only failure mode in the tool pipeline that the
proxy currently *creates* instead of repairing: the non-streaming path is always
valid, the streaming path is not.

**Independent Test**: Feed a recorded malformed payload through the streaming
parser with incremental tool calls enabled, accumulate every
`toolCallDeltas[i].function.arguments` chunk per index, and assert
`JSON.parse(accumulated)` succeeds. No client, no network, no Qwen account.

**Acceptance Scenarios**:

1. **Given** a `write` payload whose `content` value contains the invalid escape
   `\l`, **When** the turn is streamed in arbitrary chunk sizes,
   **Then** the accumulated arguments parse, and the parsed `content` contains the
   literal two characters `\l` (the model's intent is preserved, not dropped).
2. **Given** a payload whose string value ends with a Windows path backslash
   immediately before the closing quote, **When** it is streamed,
   **Then** the accumulated arguments parse and no later object's text is present
   in them.
3. **Given** a payload that is genuinely truncated mid-string, **When** the stream
   ends, **Then** the client either receives no call at all (tracked malformed,
   auto-retry eligible) or a call whose arguments parse and carry the existing
   truncation warning — never an unparseable string.
4. **Given** the same payload delivered as one chunk or as 1-character chunks,
   **Then** the accumulated arguments are byte-identical.

---

### User Story 2 - Two calls stay two calls (Priority: P1)

The model emits a `write` block followed by an `edit` block in the same turn. The
client receives two tool calls with distinct indexes, each with its own
arguments. The second call is never swallowed, and the first call's text never
appears inside the second.

**Why this priority**: Silent loss of the second call is worse than a visible
error: the agent believes the edit happened. Today a rejected close tag merges
both blocks, recovery keeps only the first object, and the merge is counted as a
success so no retry fires.

**Independent Test**: Feed two blocks where the first contains an invalid escape,
assert two calls are emitted with the expected names and that each accumulated
arguments string parses to its own object.

**Acceptance Scenarios**:

1. **Given** two well-formed blocks where the first contains `\l`, **When** the
   turn is parsed, **Then** both calls are emitted (the first close tag is
   honoured) and neither arguments string contains the other's keys.
2. **Given** one block containing two concatenated top-level objects,
   **When** the turn is parsed, **Then** the objects are split into separate calls
   up to the per-turn cap, or the extra object is explicitly tracked as dropped —
   never silently truncated.
3. **Given** a first block that is unrecoverably malformed followed by a valid
   second block, **When** the turn is parsed, **Then** no pending delta from the
   first block is delivered under the second call's index.
4. **Given** a merged turn where only one call could be recovered, **Then** the
   loss is visible in the stream summary and metrics.

---

### User Story 3 - Deterministic escape repair (Priority: P2)

An invalid escape produced by the model is repaired the same way in every code
path — boundary detection, strict argument parsing, recovery and streaming — so a
payload is never "valid enough to close the block" but "invalid to stream", or the
reverse.

**Why this priority**: The incident is caused by two disagreeing notions of JSON
validity inside the same file. Fixing only the streaming gate would leave the
merged-block bug; fixing only the repair chain would leave the raw-stream bug.

**Independent Test**: Unit-test one shared escape helper against a table of
inputs (`\l`, `\a`, `\x`, `\u00zz`, `\b`, `\f`, `C:\Users`, `https://`, `\"`,
trailing lone backslash) and assert every consumer uses it.

**Acceptance Scenarios**:

1. **Given** the same raw payload, **When** it is evaluated by close-tag
   detection, strict argument parsing and full recovery, **Then** all three agree
   on whether it is repairable and produce the same parsed value.
2. **Given** valid JSON escapes `\b` and `\f`, **Then** they are preserved as
   control characters, not double-escaped into literal text.
3. **Given** a valid payload with no invalid escape, **Then** no repair is applied
   and the emitted bytes are unchanged.

---

### User Story 4 - The failure is operable and less likely (Priority: P3)

An operator can tell from logs and metrics how often the model produced invalid
escapes, how often a block was split, and whether an integrity guard ever fired.
The model is told the escaping rules before it generates.

**Why this priority**: Constitution V and XI require evidence and prevention, but
neither changes the correctness outcome of US1–US3.

**Independent Test**: Assert the new counters increment on the incident fixtures
and that the generated tool instructions contain the escaping rule.

**Acceptance Scenarios**:

1. **Given** a repaired escape, **Then** a counter and a debug-level structured log
   record it without logging file content beyond the existing capped preview.
2. **Given** an integrity guard violation, **Then** it is counted, logged at warn
   level with the tool name and index, and never counted as a successful call.
3. **Given** a request with tools, **Then** the injected contract states the JSON
   string escaping rules and shows a Windows-path example.

---

### Edge Cases

- Invalid escape at a chunk boundary: `\` arrives in chunk N, `l` in chunk N+1.
- Incomplete `\uXX` at the end of the buffer.
- A string value ending with `\` before its closing quote (quote-parity shift).
- A literal `</qpx_call>` inside a string value (must not close the block).
- Two objects separated only by whitespace, or by a stray close tag.
- An envelope object followed by a bare arguments object (no `name`).
- Payload that is entirely prose describing tool syntax (must stay visible text).
- Per-turn cap reached while a second object is being split out.
- Duplicate call already emitted this turn (dedupe must still hold).
- Failover or auto-retry re-creates the parser mid-turn: no delta may be emitted
  twice for the same index.
- Non-streaming requests and the Anthropic/Gemini adapters must keep working
  unchanged.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The concatenation of all `arguments` deltas emitted for one tool
  call index MUST be parseable by `JSON.parse` at the moment the call is
  finalized, for every payload the proxy chooses to emit.
- **FR-002**: The proxy MUST NOT emit an `arguments` delta containing text that
  belongs to a different tool call, a different JSON object, an envelope key, or
  a tool-call marker tag.
- **FR-003**: Incremental emission MUST be bounded by the arguments value's own
  extent; when that extent is not yet known, emission MUST stop at the last
  position proven safe rather than at the end of the buffer.
- **FR-004**: Emission MUST be prefix-stable: the bytes emitted for a prefix of
  the stream MUST be a prefix of the bytes emitted for the whole stream.
- **FR-005**: An incomplete trailing escape MUST be held back until the next
  chunk resolves it, and MUST be released at flush.
- **FR-006**: Invalid JSON escapes inside string values MUST be normalized
  deterministically by one shared helper used by boundary detection, strict
  argument parsing, recovery and streaming.
- **FR-007**: The shared helper MUST treat `\b` and `\f` as valid JSON escapes.
- **FR-008**: A close tag whose payload is repairable only by escape
  normalization MUST be accepted as a block boundary.
- **FR-009**: A block containing multiple top-level JSON objects MUST be split
  into separate calls, bounded by the existing per-turn cap and dedupe rules;
  objects beyond the bound MUST be tracked explicitly, never silently truncated.
- **FR-010**: When a call is dropped as malformed, all of its unflushed pending
  deltas MUST be discarded and its incremental state reset.
- **FR-011**: At finalization the proxy MUST reconcile the accumulated emitted
  arguments with the finalized call: emit the missing suffix when the emitted
  text is a strict prefix of the canonical serialization.
- **FR-012**: If reconciliation detects divergence, the proxy MUST close the
  emitted text into parseable JSON, flag the call as truncated, count an
  integrity violation, and MUST NOT count the call as successful.
- **FR-013**: Truncation healing MUST compute closing tokens from the emitted
  span, not from the full remaining buffer.
- **FR-014**: Existing retry semantics MUST be preserved: no auto-retry when at
  least one call succeeded; integrity failures MUST be reported as malformed so
  a turn with no successful call still retries within the configured bound.
- **FR-015**: The tool-call contract injected into the prompt MUST state the JSON
  string escaping rules, including Windows paths.
- **FR-016**: New counters and structured logs MUST cover escape repair, block
  split and integrity violation, without logging secrets or uncapped content.
- **FR-017**: Non-streaming responses, Anthropic `input_json_delta` and Gemini
  `functionCall` output MUST satisfy FR-001 as a consequence of the parser fix,
  with no adapter-specific behaviour change.
- **FR-018**: Added per-chunk work MUST be proportional to the newly arrived
  bytes; already-scanned prefix bytes MUST NOT be rescanned on every chunk.

### Key Entities

- **Arguments span**: the region of the buffer holding one call's `arguments`
  value, with a start offset, a known-or-unknown end offset, and a safe-prefix
  end offset.
- **Emission ledger**: per-index record of the exact arguments text already
  handed to the client, used for reconciliation and healing.
- **Integrity violation**: a finalized call whose emitted text diverged from its
  canonical serialization; carries tool name, index and reason.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero unparseable `arguments` strings across the incident fixtures
  and the whole existing mock suite, for chunk sizes 1, 2, 7, 64 and single-feed.
- **SC-002**: The incident payload yields two calls with the expected tool names
  and the expected `content` / `oldString` values, instead of one merged call.
- **SC-003**: 100% of the new regression assertions fail before the fix and pass
  after it (verified by running the new test file on the pre-fix tree).
- **SC-004**: `npm run typecheck` and `npm run test:mock` pass with no change to
  existing test expectations.
- **SC-005**: No measurable per-chunk regression: total scanner work on a 200 KB
  streamed arguments value stays linear in the number of bytes (asserted by a
  counter-instrumented unit test, not a wall-clock benchmark).
- **SC-006**: An operator can count escape repairs, splits and integrity
  violations from `/metrics` alone, without reading raw payloads. The unchanged
  stream summary additionally makes every lost call visible (`malformedCount` for
  an integrity violation, `cappedCount` for an over-cap split object). The summary
  is not extended with the new counters: it lives in the streaming adapter, which
  FR-017 forbids editing. See research.md §7.

## Assumptions

- The model will keep producing invalid escapes occasionally; the goal is that
  the proxy never forwards them, not that the model never writes them.
- Repairing `\l` to a literal backslash followed by `l` is the intended reading
  of a Windows path or a LaTeX-style command in file content; no smarter
  intent inference is attempted.
- Deltas already written to the SSE socket cannot be retracted, so the fix is
  preventive (never emit unsafe bytes) with a bounded closing guard, not a
  retroactive rewrite.
- No new configuration flag is introduced; this is a correctness fix, not an
  optional capability.
- The per-turn cap, dedupe, prose guard and auto-retry bounds stay as they are.
