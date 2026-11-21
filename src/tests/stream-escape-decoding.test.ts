import test from "node:test";
import assert from "node:assert/strict";
import { decodeSseContentBody } from "../routes/chat/helpers.ts";

const CASES: Array<[string, string]> = [
  ["unicode escape", "\\u00e9"],
  ["carriage return", "\\r"],
  ["solidus", "\\/"],
  ["backspace", "\\b"],
  ["form feed", "\\f"],
  ["tab", "\\t"],
  ["newline", "\\n"],
  ["quote", "\\\""],
  ["backslash", "\\\\"],
  ["literal backslash n", "\\\\n"],
  ["windows path", "C:\\\\Users\\\\julie\\\\file.txt"],
  ["surrogate pair", "\\ud83d\\ude00"],
  ["empty body", ""],
  ["no escapes", "plain text"],
  ["mixed escapes", "a\\u00e9b\\nc\\\\d\\\"e"],
];

for (const [label, body] of CASES) {
  test(`escape decoding matches native JSON semantics: ${label}`, () => {
    const expected = JSON.parse(`"${body}"`) as string;
    assert.equal(decodeSseContentBody(body), expected);
  });
}

test("escape decoding is idempotent on a body needing no repair", () => {
  const body = "no escapes here";
  assert.equal(decodeSseContentBody(body), body);
});
