# Quickstart: Tool-Call Arguments JSON Integrity

**Feature**: `015-tool-call-json-integrity`

No configuration: this is a correctness fix, enabled by default (research.md D6).
All verification is mock-based; no Qwen account is required (constitution VI).

## 1. Reproduce the incident (pre-fix)

```bash
npx tsx --test --env-file=.env.test src/tests/t7-arguments-integrity.test.ts
```

Expected failures on the untouched tree (SC-003):

- `JSON.parse` of the accumulated `write` arguments throws on the `\l` fixture;
- the merged fixture exposes `oldString` / `newString` inside `emitted(0)`;
- chunk size 1 and single-feed produce different bytes for the same payload.

## 2. Verify the fix

```bash
npx tsx --test --env-file=.env.test src/tests/t7-arguments-integrity.test.ts
npx tsx --test --env-file=.env.test src/tests/json-escape-helper.test.ts
```

| Observation | Before | After |
| --- | --- | --- |
| Accumulated `write` arguments | `JSON.parse` throws `Invalid escape character l` | Parses; `content` keeps the literal `\l` |
| Calls emitted for the write+edit turn | 1 (merged) | 2, distinct indexes |
| Second call's keys inside the first | Present | Absent |
| Chunk sizes 1 / 2 / 7 / 64 / single | Divergent bytes | Byte-identical |
| Genuinely truncated payload | Unparseable or silent loss | No call (tracked malformed, retry-eligible) or parseable call with the truncation warning |
| Valid `\b` / `\f` escapes | Double-escaped into literal text | Preserved as control characters |

## 3. Regression set

```bash
npx tsx --test --env-file=.env.test src/tests/parser.test.ts src/tests/parser-truncated-tool-call.test.ts src/tests/parser-deep-coverage.test.ts src/tests/t3-close-tag-escape.test.ts src/tests/t5-tool-cap.test.ts src/tests/t6-missing-quote-array-close.test.ts src/tests/tool-recovery-t1t2.test.ts src/tests/tool-calls-endpoint.test.ts src/tests/interaction-flows.test.ts src/tests/unwrapped-tool-calls.test.ts src/tests/utils-json-full.test.ts src/tests/jsonFix.test.ts src/tests/json-recovery.test.ts src/tests/tool-instructions-cache.test.ts src/tests/anthropic.test.ts
```

All must stay green with unchanged expectations (SC-004). In particular:

- `tool-calls-endpoint.test.ts` — arguments are still emitted incrementally
  before the tool close tag (the fix must not buffer whole calls);
- `jsonFix.test.ts`, `json-recovery.test.ts` — the Windows drive-letter rule is
  preserved;
- `t3/t5/t6`, `tool-recovery-t1t2.test.ts` — close-tag selection, cap, dedupe,
  prose guard and narrow typo repairs are unchanged.

## 4. Gates

```bash
npm run typecheck
npm run test:mock
```

Both new test files must be registered in the explicit lists of `package.json`
(`test:mock` and `test:mock:fast`) before the gates are meaningful.

## 5. Observe

`GET /metrics` (names keep dots, matching the rest of the registry):

```text
toolcalls.escape_repaired 3
toolcalls.block_split 1
toolcalls.integrity_violation 0
```

Logs: debug-level records for escape repairs and block splits behind
`TOOLCALL_DEBUG=1`; a warn-level record for an integrity violation carrying the
tool name, index and reason. Content previews stay capped at the existing
2000-character limit; no credentials or account data are logged.

The three counters above are exposed by `/metrics`. The stream summary
(`src/routes/chat/streaming.ts`) keeps its unchanged `malformedCount` /
`cappedCount` fields: an integrity violation is recorded as a malformed entry and
an over-cap split object as a capped drop, so a lost call is never silent. Block
splits are counted in `/metrics` only — the summary is deliberately not extended,
because the fix is parser-only (FR-017). SC-006 is satisfied by `/metrics` plus
the unchanged summary.

## Troubleshooting

- **`toolcalls.integrity_violation` > 0 after the fix**: the divergence guard
  (contract I7) fired. Inspect the warn record; it must stay at 0 on the escape
  fixtures. A non-zero value on real traffic means a payload class the gate does
  not yet cover — capture it as a new fixture in `t7-arguments-integrity.test.ts`.
- **A second call is missing**: check the per-turn cap (4) and the dedupe key.
  Over-bound objects are recorded as capped drops and appear in the stream
  summary; they are never silently truncated.
- **`\b` / `\f` became literal text**: helper regression — run
  `json-escape-helper.test.ts` and `utils-json-full.test.ts`.
- **Streaming stopped being incremental**: the safe-prefix gate is holding back
  too much; `tool-calls-endpoint.test.ts` guards the incremental contract.
- **Anthropic or Gemini output changed shape**: it must not — the fix is
  parser-only (FR-017). Run `anthropic.test.ts` and the Gemini suites.
