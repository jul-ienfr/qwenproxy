import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamingToolParser } from "../tools/parser.ts";
import { metrics } from "../core/metrics.ts";

const TOOLS: any[] = [
  {
    type: "function",
    function: {
      name: "tool1",
      description: "first tool",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
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
  {
    type: "function",
    function: {
      name: "edit",
      description: "edit a file",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          oldString: { type: "string" },
          newString: { type: "string" },
        },
      },
    },
  },
];

const CONTENT_RAW =
  '# Runbook\\nSeuils `A=3` ;\\leur migration\\n```powershell\\npythonw scripts\\\\app_supervisor.py\\n```\\n';
const WRITE_ARGS =
  '{"filePath":"C:\\\\Users\\\\julie\\\\app.md","content":"' + CONTENT_RAW + '"}';
const EDIT_ARGS =
  '{"filePath":"C:\\\\Users\\\\julie\\\\checklist.md","oldString":"- [ ] T011","newString":"- [x] T011"}';
const WRITE_BLOCK = `<qpx_call>{"name":"write","arguments":${WRITE_ARGS}}</qpx_call>`;
const EDIT_BLOCK = `<qpx_call>{"name":"edit","arguments":${EDIT_ARGS}}</qpx_call>`;

const EXPECTED_CONTENT =
  "# Runbook\nSeuils `A=3` ;\\leur migration\n```powershell\npythonw scripts\\app_supervisor.py\n```\n";

interface StreamRun {
  parser: StreamingToolParser;
  byIndex: Map<number, string>;
  names: Map<number, string>;
  complete: any[];
  text: string;
}

function stream(
  input: string,
  chunkSize: number,
  options: any = { incrementalToolCalls: true },
): StreamRun {
  const parser = new StreamingToolParser(TOOLS, options);
  const byIndex = new Map<number, string>();
  const names = new Map<number, string>();
  const complete: any[] = [];
  let text = "";
  const absorb = (result: any) => {
    text += result.text;
    for (const delta of result.toolCallDeltas) {
      if (delta.function?.name) names.set(delta.index, delta.function.name);
      byIndex.set(
        delta.index,
        (byIndex.get(delta.index) ?? "") + (delta.function?.arguments ?? ""),
      );
    }
    complete.push(...result.toolCalls);
  };
  if (chunkSize <= 0) {
    absorb(parser.feed(input));
  } else {
    for (let i = 0; i < input.length; i += chunkSize) {
      absorb(parser.feed(input.slice(i, i + chunkSize)));
    }
  }
  absorb(parser.flush());
  return { parser, byIndex, names, complete, text };
}

function emittedArgs(run: StreamRun, index: number): string {
  const streamed = run.byIndex.get(index);
  if (streamed !== undefined) return streamed;
  const call = run.complete[index];
  return call ? JSON.stringify(call.arguments) : "";
}

function callCount(run: StreamRun): number {
  return run.byIndex.size + run.complete.length;
}

const CHUNK_SIZES = [1, 2, 7, 64, 0];

test("T7: incident write payload always yields parseable arguments (I1)", () => {
  for (const chunkSize of CHUNK_SIZES) {
    const run = stream(WRITE_BLOCK, chunkSize);
    assert.equal(callCount(run), 1, `chunkSize=${chunkSize}: one call`);
    const args = emittedArgs(run, 0);
    let parsed: any;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(args);
    }, `chunkSize=${chunkSize}: accumulated arguments must parse`);
    assert.equal(parsed.filePath, "C:\\Users\\julie\\app.md");
    assert.equal(parsed.content, EXPECTED_CONTENT);
    assert.ok(
      parsed.content.includes(";\\leur migration"),
      "the literal backslash-l must survive, not be dropped",
    );
    assert.equal(run.parser.getMalformedToolCalls().length, 0);
  }
});

test("T7: emission is prefix-stable across chunk sizes (I3)", () => {
  const baseline = emittedArgs(stream(WRITE_BLOCK, 0), 0);
  for (const chunkSize of [1, 2, 7, 64]) {
    assert.equal(
      emittedArgs(stream(WRITE_BLOCK, chunkSize), 0),
      baseline,
      `chunkSize=${chunkSize} must be byte-identical to single-feed`,
    );
  }
});

test("T7: an incomplete \\uXXXX at a chunk boundary is held back (FR-005)", () => {
  const block =
    '<qpx_call>{"name":"write","arguments":{"filePath":"a.md","content":"A\\u0041B"}}</qpx_call>';
  for (const chunkSize of CHUNK_SIZES) {
    const run = stream(block, chunkSize);
    const parsed = JSON.parse(emittedArgs(run, 0));
    assert.equal(parsed.content, "AAB", `chunkSize=${chunkSize}`);
  }
});

test("T7: two blocks stay two calls with no cross-contamination (I2)", () => {
  for (const chunkSize of CHUNK_SIZES) {
    const run = stream(WRITE_BLOCK + EDIT_BLOCK, chunkSize);
    assert.equal(callCount(run), 2, `chunkSize=${chunkSize}: two calls`);
    const first = emittedArgs(run, 0);
    const second = emittedArgs(run, 1);
    assert.ok(!first.includes("oldString"), "write args must not carry edit keys");
    assert.ok(!first.includes("newString"));
    assert.ok(!second.includes("content"), "edit args must not carry write keys");
    assert.equal(JSON.parse(first).content, EXPECTED_CONTENT);
    assert.deepEqual(JSON.parse(second), {
      filePath: "C:\\Users\\julie\\checklist.md",
      oldString: "- [ ] T011",
      newString: "- [x] T011",
    });
  }
});

test("T7: a value ending in a backslash never leaks the next object (I4)", () => {
  const parityShift =
    '<qpx_call>{"name":"write","arguments":{"filePath":"a.md","content":"abc\\"}}</qpx_call>';
  for (const chunkSize of CHUNK_SIZES) {
    const run = stream(parityShift + EDIT_BLOCK, chunkSize);
    const first = run.byIndex.get(0);
    if (first !== undefined) {
      assert.ok(!first.includes("oldString"), "no cross-object bytes");
      assert.doesNotThrow(() => JSON.parse(first));
    }
    for (const [index, text] of run.byIndex) {
      assert.doesNotThrow(
        () => JSON.parse(text),
        `chunkSize=${chunkSize} index=${index} must parse`,
      );
    }
  }
});

test("T7: concatenated top-level objects are split, never truncated (FR-009)", () => {
  const merged = `<qpx_call>{"name":"write","arguments":${WRITE_ARGS}}{"name":"edit","arguments":${EDIT_ARGS}}</qpx_call>`;
  for (const chunkSize of CHUNK_SIZES) {
    const run = stream(merged, chunkSize);
    const dropped = run.parser.getCappedToolCalls().length;
    assert.equal(
      callCount(run) + dropped,
      2,
      `chunkSize=${chunkSize}: both objects accounted for`,
    );
    assert.ok(callCount(run) >= 1);
    for (const [index, text] of run.byIndex) {
      assert.doesNotThrow(() => JSON.parse(text), `index=${index}`);
    }
  }
});

test("T7: a malformed block leaves no orphan delta for the next call (I8)", () => {
  const malformed =
    '<qpx_call>{"name":"write"(oops){"content":"broken"}}</qpx_call>';
  for (const chunkSize of CHUNK_SIZES) {
    const run = stream(malformed + EDIT_BLOCK, chunkSize);
    assert.equal(callCount(run), 1, `chunkSize=${chunkSize}: only the edit call`);
    const args = emittedArgs(run, 0);
    assert.ok(!args.includes("broken"), "no bytes from the dropped block");
    assert.deepEqual(JSON.parse(args), {
      filePath: "C:\\Users\\julie\\checklist.md",
      oldString: "- [ ] T011",
      newString: "- [x] T011",
    });
    assert.ok(run.parser.getMalformedToolCalls().length >= 1);
  }
});

test("T7: a truncated payload with no prior call is dropped, not streamed", () => {
  const truncated =
    '<qpx_call>{"name":"write","arguments":{"filePath":"a.md","content":"half written';
  const run = stream(truncated, 7);
  assert.equal(callCount(run), 0);
  assert.equal(run.byIndex.size, 0, "no partial arguments may reach the client");
  assert.equal(run.parser.getMalformedToolCalls().length, 1);
  assert.equal(run.parser.getMalformedToolCalls()[0].category, "truncated");
});

test("T7: healing after a prior call stays parseable and warns (FR-013)", () => {
  const prior =
    '<qpx_call>{"name":"tool1","arguments":{"path":"a.txt"}}</qpx_call>';
  const truncated =
    '<qpx_call>{"name":"write","arguments":{"filePath":"a.md","content":"half written';
  const run = stream(prior + truncated, 7);
  const args = emittedArgs(run, 1);
  const parsed = JSON.parse(args);
  assert.equal(parsed.filePath, "a.md");
  assert.ok(
    parsed.content.includes("TRUNCATED BY UPSTREAM MODEL OUTPUT LIMIT"),
    "the warning must ride the emitted span",
  );
});

test("T7: escape repairs and block splits are counted (FR-016)", () => {
  metrics.reset();
  stream(WRITE_BLOCK, 7);
  assert.ok(
    (metrics.get("toolcalls.escape_repaired")?.value ?? 0) > 0,
    "escape_repaired must increment on the incident fixture",
  );
  assert.equal(metrics.get("toolcalls.integrity_violation")?.value ?? 0, 0);

  metrics.reset();
  stream(
    `<qpx_call>{"name":"write","arguments":${WRITE_ARGS}}{"name":"edit","arguments":${EDIT_ARGS}}</qpx_call>`,
    0,
  );
  assert.ok(
    (metrics.get("toolcalls.block_split")?.value ?? 0) > 0,
    "block_split must increment on the concatenated fixture",
  );
});

test("T7: divergence guard closes the ledger and is not a success (I7)", () => {
  metrics.reset();
  const parser = new StreamingToolParser(TOOLS, { incrementalToolCalls: true });
  parser.feed(
    '<qpx_call>{"name":"write","arguments":{"filePath":"a.md","content":"hello',
  );
  const active = (parser as any).activeIncrementalToolCall;
  assert.ok(active, "an incremental call must be active");
  const divergentLedger = '{"filePath":"a.md","content":"hello","extra":';
  active.emittedArgumentsText = divergentLedger;
  active.disabled = true;
  const pending = (parser as any).pendingToolCallDeltas;
  assert.ok(pending.length > 0, "the divergent text must already be on the wire");
  pending[0].function.arguments = divergentLedger;
  const fed = parser.feed(' world"}}</qpx_call>');
  const flushed = parser.flush();
  const text = [...fed.toolCallDeltas, ...flushed.toolCallDeltas]
    .filter((d) => d.index === 0)
    .map((d) => d.function?.arguments ?? "")
    .join("");
  assert.doesNotThrow(() => JSON.parse(text), "the guard must close the ledger");
  assert.ok(
    (metrics.get("toolcalls.integrity_violation")?.value ?? 0) > 0,
    "the violation must be counted",
  );
  assert.equal(parser.getSuccessfulToolCallCount(), 0);
  assert.ok(parser.getMalformedToolCalls().length >= 1);
});

test("T7: scanner work stays linear in the streamed bytes (SC-005)", () => {
  const big = "x".repeat(200 * 1024);
  const block = `<qpx_call>{"name":"write","arguments":{"filePath":"a.md","content":"${big}"}}</qpx_call>`;
  const parser = new StreamingToolParser(TOOLS, { incrementalToolCalls: true });
  const counter = (parser as any).getIncrementalScanByteCount;
  assert.equal(typeof counter, "function", "scan-byte instrumentation required");
  for (let i = 0; i < block.length; i += 64) {
    parser.feed(block.slice(i, i + 64));
  }
  parser.flush();
  const scanned = (parser as any).getIncrementalScanByteCount();
  assert.ok(
    scanned <= block.length * 4,
    `scanned ${scanned} bytes for ${block.length} streamed bytes (must be linear)`,
  );
});

const BROKEN_WRITE_OBJ = '{"name":"write","arguments":{"content":"a" "b"}}';

test("T7: merged block with an unparseable first object leaks no deltas (I1/I8)", () => {
  const editEnvelope = `{"name":"edit","arguments":${EDIT_ARGS}}`;
  for (const chunkSize of CHUNK_SIZES) {
    const run = stream(
      `<qpx_call>${BROKEN_WRITE_OBJ}${editEnvelope}</qpx_call>`,
      chunkSize,
    );
    assert.equal(callCount(run), 1, `chunkSize=${chunkSize}: only the edit call`);
    for (const [index, text] of run.byIndex) {
      assert.doesNotThrow(
        () => JSON.parse(text),
        `chunkSize=${chunkSize} index=${index} must parse`,
      );
      assert.ok(!text.includes('"content"'), "no bytes from the broken object");
    }
    assert.deepEqual(JSON.parse(emittedArgs(run, 0)), {
      filePath: "C:\\Users\\julie\\checklist.md",
      oldString: "- [ ] T011",
      newString: "- [x] T011",
    });
    assert.ok(run.parser.getMalformedToolCalls().length >= 1);
  }
});

test("T7: a broken first object must not trip the guard on a same-name sibling", () => {
  metrics.reset();
  const goodWrite =
    '{"name":"write","arguments":{"filePath":"ok.md","content":"fine"}}';
  const run = stream(`<qpx_call>${BROKEN_WRITE_OBJ}${goodWrite}</qpx_call>`, 7);
  assert.equal(callCount(run), 1);
  assert.deepEqual(JSON.parse(emittedArgs(run, 0)), {
    filePath: "ok.md",
    content: "fine",
  });
  assert.equal(metrics.get("toolcalls.integrity_violation")?.value ?? 0, 0);
  assert.equal(run.parser.getSuccessfulToolCallCount(), 1);
});

test("T7: two unparseable merged objects record exactly two malformed entries", () => {
  const run = stream(
    `<qpx_call>${BROKEN_WRITE_OBJ}${BROKEN_WRITE_OBJ}</qpx_call>`,
    0,
  );
  assert.equal(callCount(run), 0);
  assert.equal(run.parser.getMalformedToolCalls().length, 2);
});
