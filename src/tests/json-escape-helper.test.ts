import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeJsonStringEscapes,
  robustParseJSON,
} from "../utils/json.ts";
import { StreamingToolParser } from "../tools/parser.ts";

const TOOLS: any[] = [
  {
    type: "function",
    function: {
      name: "write",
      description: "write a file",
      parameters: {
        type: "object",
        properties: { filePath: { type: "string" }, content: { type: "string" } },
      },
    },
  },
];

test("normalizeJsonStringEscapes: invalid escapes become a literal backslash", () => {
  const cases: Array<[string, string]> = [
    ['{"a":"x\\ly"}', '{"a":"x\\\\ly"}'],
    ['{"a":"x\\ay"}', '{"a":"x\\\\ay"}'],
    ['{"a":"x\\xy"}', '{"a":"x\\\\xy"}'],
    ['{"a":"x\\qy"}', '{"a":"x\\\\qy"}'],
    ['{"a":"x\\u00zzy"}', '{"a":"x\\\\u00zzy"}'],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(normalizeJsonStringEscapes(raw), expected, `raw=${raw}`);
    assert.deepEqual(JSON.parse(normalizeJsonStringEscapes(raw)), {
      a: JSON.parse(expected).a,
    });
  }
});

test("normalizeJsonStringEscapes: \\b and \\f are valid JSON escapes (FR-007)", () => {
  const raw = '{"a":"x\\by\\fz"}';
  assert.equal(normalizeJsonStringEscapes(raw), raw);
  assert.deepEqual(JSON.parse(normalizeJsonStringEscapes(raw)), {
    a: "x\by\fz",
  });
  assert.deepEqual(robustParseJSON(raw), { a: "x\by\fz" });
});

test("normalizeJsonStringEscapes: valid payloads are byte-unchanged", () => {
  const payload = JSON.stringify({
    name: "write",
    arguments: {
      filePath: "C:\\Users\\julie\\app.md",
      content: "line1\nline2\ttab \"quoted\" \\ backslash / slash",
    },
  });
  assert.equal(normalizeJsonStringEscapes(payload), payload);
});

test("normalizeJsonStringEscapes: idempotent on repaired and valid input", () => {
  const inputs = [
    '{"a":"x\\ly"}',
    '{"a":"bad \\u00zz escape"}',
    '{"a":"C:\\\\Users\\\\test"}',
    JSON.stringify({ a: "multi\nline\t\"q\"" }),
  ];
  for (const input of inputs) {
    const once = normalizeJsonStringEscapes(input);
    assert.equal(normalizeJsonStringEscapes(once), once, `input=${input}`);
  }
});

test("normalizeJsonStringEscapes: never closes strings or containers", () => {
  const truncated = '{"a":"abc';
  assert.equal(normalizeJsonStringEscapes(truncated), truncated);
  const trailingBackslash = '{"a":"abc\\';
  const normalized = normalizeJsonStringEscapes(trailingBackslash);
  assert.equal(normalized, '{"a":"abc\\\\');
  assert.throws(() => JSON.parse(normalized));
});

test("normalizeJsonStringEscapes: keeps the Windows drive-letter rule", () => {
  const code = 'path = "C:\\Users\\test\\file.txt"\nprint(path)';
  const payload = JSON.stringify({
    name: "write",
    arguments: { content: code },
  });
  assert.equal(normalizeJsonStringEscapes(payload), payload);
  assert.equal(robustParseJSON(payload).arguments.content, code);
});

test("cross-path agreement: normalization, recovery, boundary and emission (US3)", () => {
  const rawArgs = '{"filePath":"a.md","content":"seuil ;\\leur migration"}';
  const payload = `{"name":"write","arguments":${rawArgs}}`;
  const block = `<qpx_call>${payload}</qpx_call>`;
  const payload2 = payload.replace('"filePath":"a.md"', '"filePath":"b.md"');
  const block2 = `<qpx_call>${payload2}</qpx_call>`;

  const normalized = JSON.parse(normalizeJsonStringEscapes(payload));
  const normalized2 = JSON.parse(normalizeJsonStringEscapes(payload2));
  const recovered = robustParseJSON(payload);
  assert.deepEqual(recovered, normalized);

  const parser = new StreamingToolParser(TOOLS, { incrementalToolCalls: true });
  const fed = parser.feed(block + block2);
  const flushed = parser.flush();
  const deltas = [...fed.toolCallDeltas, ...flushed.toolCallDeltas];
  const complete = [...fed.toolCalls, ...flushed.toolCalls];

  const indexes = [...new Set(deltas.map((d) => d.index))];
  const emittedCount = indexes.length + complete.length;
  assert.equal(emittedCount, 2, "the correct first close tag must be honoured");

  const expectedArgs = [normalized.arguments, normalized2.arguments];
  for (const index of indexes) {
    const text = deltas
      .filter((d) => d.index === index)
      .map((d) => d.function?.arguments ?? "")
      .join("");
    assert.deepEqual(JSON.parse(text), expectedArgs[index]);
  }
  for (const call of complete) {
    assert.ok(
      expectedArgs.some(
        (args) => JSON.stringify(args) === JSON.stringify(call.arguments),
      ),
    );
  }
});

test("cross-path agreement: a valid payload streams byte-unchanged", () => {
  const rawArgs = '{"filePath":"a.md","content":"plain text"}';
  const parser = new StreamingToolParser(TOOLS, { incrementalToolCalls: true });
  const fed = parser.feed(`<qpx_call>{"name":"write","arguments":${rawArgs}}</qpx_call>`);
  const flushed = parser.flush();
  const text = [...fed.toolCallDeltas, ...flushed.toolCallDeltas]
    .map((d) => d.function?.arguments ?? "")
    .join("");
  assert.equal(text, rawArgs);
});
