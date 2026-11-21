import test from "node:test";
import assert from "node:assert/strict";
import {
  createSseContentExtractor,
  createSseWriteBuffer,
  decodeSseContentBody,
  getEscapeDecodePasses,
  getIncrementalDelta,
  getSseScanChars,
  getSuffixCopyChars,
  resetHotPathCounters,
  SSE_PENDING_WRITE_LIMIT_BYTES,
} from "../routes/chat/helpers.ts";
import {
  getParserScanChars,
  resetParserCounters,
  StreamingToolParser,
} from "../tools/parser.ts";

const CHUNK_BYTES = 1024;

function incrementalRun(totalBytes: number): number {
  resetHotPathCounters();
  let accumulated = "";
  let length = 0;
  let suffix = "";
  let emittedLength = 0;
  const chunks = Math.floor(totalBytes / CHUNK_BYTES);

  for (let i = 0; i < chunks; i++) {
    const body =
      (i === 0 ? "A" : "B") + "y".repeat(CHUNK_BYTES - 2) + "\n";
    const result = getIncrementalDelta(accumulated, body, length, suffix);
    assert.equal(result.delta, body, "strictly incremental delta must pass through");
    emittedLength += result.delta.length;
    accumulated = result.matchedContent;
    length = result.contentLength;
    suffix = result.contentSuffix;
  }

  assert.equal(emittedLength, totalBytes);
  assert.equal(length, totalBytes);
  assert.equal(suffix, accumulated.slice(-32), "suffix must stay correct");
  return getSuffixCopyChars();
}

test("hot path B1: suffix copies stay linear in answer size", () => {
  const smallBytes = 10 * 1024;
  const mediumBytes = 100 * 1024;
  const largeBytes = 1024 * 1024;

  const small = incrementalRun(smallBytes);
  const medium = incrementalRun(mediumBytes);
  const large = incrementalRun(largeBytes);

  assert.ok(small > 0 && medium > 0 && large > 0);

  const smallRatio = small / smallBytes;
  const largeRatio = large / largeBytes;
  assert.ok(
    largeRatio <= smallRatio * 2,
    `suffix copy cost per byte must not grow with answer size: ` +
      `10KB=${smallRatio.toFixed(4)} 1MB=${largeRatio.toFixed(4)}`,
  );
});

test("hot path B2: exactly one escape-decode pass per chunk", () => {
  resetHotPathCounters();
  decodeSseContentBody("a\\u00e9b\\nc\\\\d");
  assert.equal(getEscapeDecodePasses(), 1);
});

test("hot path B5: pending client-write bytes stay bounded with a throttled consumer", async () => {
  const flushBytes = 8192;
  const bound = SSE_PENDING_WRITE_LIMIT_BYTES + flushBytes;
  const chunk = "x".repeat(flushBytes);
  const totalChunks = 32;
  let inFlight = 0;
  let maxInFlight = 0;
  const received: string[] = [];
  const pending: Promise<void>[] = [];

  const sink = (data: string): Promise<void> => {
    inFlight += data.length;
    maxInFlight = Math.max(maxInFlight, inFlight);
    received.push(data);
    const settled = new Promise<void>((resolve) => {
      setTimeout(() => {
        inFlight -= data.length;
        resolve();
      }, 1);
    });
    pending.push(settled);
    return settled;
  };

  const buffer = createSseWriteBuffer(sink, {
    flushBytes,
    flushMs: 3,
    pendingLimitBytes: SSE_PENDING_WRITE_LIMIT_BYTES,
    isCancelled: () => false,
  });

  for (let i = 0; i < totalChunks; i++) {
    buffer.write(chunk);
    await buffer.drain();
  }
  buffer.flush();
  await buffer.settled();
  await Promise.all(pending);
  buffer.dispose();

  assert.equal(received.join(""), chunk.repeat(totalChunks));
  assert.ok(
    maxInFlight <= bound,
    `pending client-write bytes must stay bounded: max=${maxInFlight} bound=${bound}`,
  );
});

function cumulativeRun(totalBytes: number): number {
  resetHotPathCounters();
  const extractor = createSseContentExtractor();
  let accumulated = "";
  let length = 0;
  let suffix = "";
  let emitted = 0;
  let raw = "";
  const chunks = Math.floor(totalBytes / CHUNK_BYTES);

  for (let i = 0; i < chunks; i++) {
    raw += (i === 0 ? "A" : "B") + "y".repeat(CHUNK_BYTES - 2) + "\n";
    const body = JSON.stringify(raw).slice(1, -1);
    const line = `{"response_id":"r1","choices":[{"delta":{"content":"${body}"}}]}`;
    const result = extractor.extract(line, length);
    assert.ok(result, "cumulative content line must extract");
    const delta = result.appended
      ? result.delta
      : getIncrementalDelta(accumulated, result.content, length, suffix).delta;
    emitted += delta.length;
    accumulated = result.content;
    length = result.contentLength;
    suffix = result.contentSuffix;
  }

  assert.equal(emitted, totalBytes);
  assert.equal(length, totalBytes);
  return getSseScanChars();
}

test("hot path B4: cumulative parsing does not re-scan the consumed prefix", () => {
  const smallBytes = 10 * 1024;
  const largeBytes = 1024 * 1024;

  const small = cumulativeRun(smallBytes);
  const large = cumulativeRun(largeBytes);

  assert.ok(small > 0 && large > 0);

  const smallRatio = small / smallBytes;
  const largeRatio = large / largeBytes;
  assert.ok(
    largeRatio <= smallRatio * 2,
    `cumulative scan cost per byte must not grow with answer size: ` +
      `10KB=${smallRatio.toFixed(4)} 1MB=${largeRatio.toFixed(4)}`,
  );
});

function toolCallRun(totalBytes: number): number {
  resetParserCounters();
  const parser = new StreamingToolParser();
  const filler = "x".repeat(totalBytes);
  const payload =
    `<tool_call>{"name":"write","arguments":` +
    `{"path":"a.txt","content":"${filler}"}}</tool_call>`;

  for (let i = 0; i < payload.length; i += CHUNK_BYTES) {
    parser.feed(payload.slice(i, i + CHUNK_BYTES));
  }

  const scanned = getParserScanChars();
  assert.ok(scanned > 0, "boundary scan must have run");
  return scanned;
}

test("hot path B6: tool-block boundary scanning is incremental", () => {
  const smallBytes = 10 * 1024;
  const largeBytes = 100 * 1024;

  const small = toolCallRun(smallBytes);
  const large = toolCallRun(largeBytes);

  const smallRatio = small / smallBytes;
  const largeRatio = large / largeBytes;
  assert.ok(
    largeRatio <= smallRatio * 2,
    `boundary scan cost per byte must not grow with payload size: ` +
      `10KB=${smallRatio.toFixed(4)} 100KB=${largeRatio.toFixed(4)}`,
  );
});
