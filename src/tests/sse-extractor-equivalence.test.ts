import test from "node:test";
import assert from "node:assert/strict";
import {
  createSseContentExtractor,
  getIncrementalDelta,
} from "../routes/chat/helpers.ts";

function line(body: string): string {
  return `{"response_id":"r1","choices":[{"delta":{"content":"${body}"}}]}`;
}

function escaped(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

const SOURCE =
  "const x = 1;\n" +
  "path C:\\\\new\\\\file.txt\n" +
  "accent é and emoji 😀\n" +
  "quote \" and tab \t end";

const ASCII_SOURCE =
  "const x = 1;\n" +
  "path C:\\\\new\\\\file.txt\n" +
  "quote \" and tab \t end";

function splitIntoChunks(text: string, size: number): string[] {
  if (size <= 0) return [text];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    parts.push(text.slice(i, i + size));
  }
  return parts;
}

function runCumulative(parts: string[], expectEveryGrowthAppended: boolean): void {
  const extractor = createSseContentExtractor();
  let previous = "";
  let length = 0;
  let suffix = "";
  let appendedCount = 0;
  const deltas: string[] = [];

  for (const part of parts) {
    const accumulated = previous + part;
    const extracted = extractor.extract(line(escaped(accumulated)), length);
    assert.ok(extracted, "cumulative line must extract");
    assert.equal(extracted.content, accumulated, "decoded content must match");

    if (extracted.appended) {
      appendedCount++;
      deltas.push(extracted.delta);
    } else {
      const incremental = getIncrementalDelta(
        previous,
        extracted.content,
        length,
        suffix,
      );
      deltas.push(incremental.delta);
    }

    previous = accumulated;
    length = extracted.contentLength;
    suffix = extracted.contentSuffix;
  }

  assert.equal(deltas.join(""), parts.join(""), "deltas must rebuild the answer");
  if (expectEveryGrowthAppended) {
    assert.equal(
      appendedCount,
      Math.max(0, parts.length - 1),
      "the optimised append path must be exercised at every growth step",
    );
  }
}

function runIncremental(parts: string[]): string[] {
  const extractor = createSseContentExtractor();
  let accumulated = "";
  let length = 0;
  const deltas: string[] = [];

  for (const part of parts) {
    const extracted = extractor.extract(line(escaped(part)), length);
    assert.ok(extracted, "line must extract");
    assert.equal(extracted.appended, false, "non-cumulative line must not append");
    accumulated += extracted.content;
    length = extracted.contentLength;
    deltas.push(extracted.content);
  }

  assert.equal(accumulated, parts.join(""));
  return deltas;
}

function runMixed(parts: string[]): string[] {
  const extractor = createSseContentExtractor();
  let accumulated = "";
  let length = 0;
  let suffix = "";
  const deltas: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const cumulative = i % 3 !== 2;
    const text = cumulative ? accumulated + parts[i] : parts[i];
    const extracted = extractor.extract(line(escaped(text)), length);
    assert.ok(extracted, "line must extract");
    const incremental = extracted.appended
      ? null
      : getIncrementalDelta(accumulated, extracted.content, length, suffix);
    deltas.push(incremental ? incremental.delta : extracted.delta);
    accumulated = incremental
      ? incremental.matchedContent
      : extracted.content;
    length = incremental ? incremental.contentLength : extracted.contentLength;
    suffix = incremental ? incremental.contentSuffix : extracted.contentSuffix;
  }

  assert.equal(accumulated, parts.join(""));
  return deltas;
}

for (const size of [1, 2, 7, 64]) {
  test(`extractor equivalence: cumulative at chunk size ${size}`, () => {
    runCumulative(splitIntoChunks(SOURCE, size), false);
  });

  test(`extractor equivalence: incremental at chunk size ${size}`, () => {
    assert.equal(runIncremental(splitIntoChunks(SOURCE, size)).join(""), SOURCE);
  });

  test(`extractor equivalence: mixed at chunk size ${size}`, () => {
    assert.equal(runMixed(splitIntoChunks(SOURCE, size)).join(""), SOURCE);
  });
}

for (const size of [1, 7, 64]) {
  test(`extractor equivalence: ASCII growth takes the append path at size ${size}`, () => {
    runCumulative(splitIntoChunks(ASCII_SOURCE, size), true);
  });
}

test("extractor equivalence: single-chunk stream", () => {
  runCumulative([SOURCE], false);
  assert.equal(runIncremental([SOURCE]).join(""), SOURCE);
  assert.equal(runMixed([SOURCE]).join(""), SOURCE);
});

test("extractor equivalence: a rewritten cumulative body falls back to a full scan", () => {
  const extractor = createSseContentExtractor();
  const first = extractor.extract(line(escaped("hello world")), 0);
  assert.ok(first);
  const rewrites = ["hello WORLD", "hello there", "hello world again"];
  for (const text of rewrites) {
    const extracted = extractor.extract(line(escaped(text)), first.contentLength);
    assert.ok(extracted, "rewritten line must still extract");
    assert.equal(extracted.appended, false, "rewrite must not be treated as append");
    assert.equal(extracted.content, text);
  }
});

test("extractor equivalence: a stale caller length resynchronises via full scan", () => {
  const extractor = createSseContentExtractor();
  const first = extractor.extract(line(escaped("abc")), 0);
  assert.ok(first);
  const second = extractor.extract(line(escaped("abcdef")), 0);
  assert.ok(second);
  assert.equal(second.appended, false);
  assert.equal(second.content, "abcdef");
  const third = extractor.extract(
    line(escaped("abcdefghi")),
    second.contentLength,
  );
  assert.ok(third);
  assert.equal(third.appended, true);
  assert.equal(third.delta, "ghi");
});
