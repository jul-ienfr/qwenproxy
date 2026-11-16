# Contract: Tool-Call Arguments Emission

**Feature**: 015-tool-call-json-integrity | **Date**: 2026-11-16

This contract binds every path that hands tool-call arguments to a client:
OpenAI chat streaming deltas and complete calls, OpenAI Responses, Anthropic
`input_json_delta`, and Gemini `functionCall.args`.

## Definitions

- `emitted(i)` — concatenation of every `arguments` string delivered for tool-call
  index `i`, in delivery order, up to and including finalization.
- `canonical(call)` — `JSON.stringify(call.arguments)` for the finalized call.
- `arguments span` — the region of the parser buffer holding one call's
  `arguments` value.

## Invariants

### I1 — Parseability (hard)

For every index `i` the proxy finalizes as a tool call, `JSON.parse(emitted(i))`
succeeds and yields an object. No exception, no partial value, no trailing data.

**Covers**: FR-001, FR-017. **Test**: `t7-arguments-integrity.test.ts` — incident
fixtures × chunk sizes {1, 2, 7, 64, single}.

### I2 — Single-call purity (hard)

`emitted(i)` contains no text belonging to another call: no second top-level
object, no envelope key (`"name"`, `"arguments"`), no `<qpx_call>` / `</qpx_call>`
marker, no lead-in prose.

**Covers**: FR-002, FR-003. **Test**: two-block fixture where the first block
contains `\l`; assert `emitted(0)` has no `oldString` / `newString` keys and
`emitted(1)` has no `content` key.

### I3 — Prefix stability

For any split of the same upstream text into chunks, `emitted(i)` is identical.
Emitting a prefix of the stream never produces bytes that are not a prefix of the
full-stream emission.

**Covers**: FR-004, FR-005. **Test**: chunk-size matrix equality assertion, plus a
fixture where `\` and `l` arrive in different chunks and one where `\u00` arrives
incomplete.

### I4 — Value-extent bounding

When the arguments-value end offset is unknown, emission stops at the last
position the scanner proved safe. The buffer length is never used as a span end.

**Covers**: FR-003. **Test**: fixture whose string value ends with a backslash
before its closing quote (quote-parity shift); assert no cross-object bytes.

### I5 — Deterministic escape normalization

One helper decides escape validity for boundary detection, strict argument
parsing, recovery and emission. Valid escapes `\" \\ \/ \b \f \n \r \t \uXXXX`
are preserved; any other escape becomes a literal backslash plus the character.
The Windows drive-letter rule for `\n \r \t` is preserved. Valid payloads are
byte-unchanged.

**Covers**: FR-006, FR-007, FR-008. **Test**: `json-escape-helper.test.ts` table;
`utils-json-full.test.ts`, `jsonFix.test.ts`, `json-recovery.test.ts` stay green.

### I6 — Reconciliation

At finalization, if `emitted(i)` is a strict prefix of `canonical(call)`, the
missing suffix is delivered as a final delta. After that delivery
`emitted(i) === canonical(call)`.

**Covers**: FR-011. **Test**: held-back-tail fixture; assert deep equality of
`JSON.parse(emitted(i))` with the finalized arguments object.

### I7 — Bounded divergence guard

If `emitted(i)` diverges from `canonical(call)`, the proxy closes the emitted text
into parseable JSON from the emitted span, marks the call truncated, increments
`toolcalls.integrity_violation`, records a malformed entry, and does not count the
call as successful. The client never hangs on an open, unparseable call.

**Covers**: FR-012, FR-013, FR-014. **Test**: forced-divergence fixture (inject a
divergent ledger) asserts parseability, the warning field, the counter, and that
`decideMissingToolCallRetry` returns `malformed` when no other call succeeded.

### I8 — Drop hygiene

A call dropped as malformed, undeclared, capped, empty or prose leaves no pending
delta behind and resets its incremental state. A later call's index never carries
an earlier dropped call's bytes.

**Covers**: FR-009, FR-010. **Test**: malformed-then-valid two-block fixture;
assert exactly one emitted index and that its arguments parse to the second call.

## Non-goals

- The contract does not require the model to emit valid JSON; it requires the
  proxy to never forward invalid JSON.
- It does not change the per-turn cap, dedupe, prose guard, retry bounds, tool
  name resolution or any wire format.
- It does not retract bytes already written to the socket; I1 is achieved by
  never writing unsafe bytes, with I7 as the bounded fallback.

## Observability contract

| Counter | Increments when |
|---|---|
| `toolcalls.escape_repaired` | an invalid escape was normalized before emission or parsing |
| `toolcalls.block_split` | a block was split into multiple top-level objects |
| `toolcalls.integrity_violation` | I7 fired |

Logs: warn level for I7 (tool name, index, reason), debug level for repairs and
splits behind `TOOLCALL_DEBUG=1`. Content previews stay capped at the existing
2000-character limit; no credentials or account data are logged.
