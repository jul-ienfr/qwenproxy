import test from "node:test";
import assert from "node:assert/strict";

import {
  extractSseError,
  statusForSseError,
} from "../utils/sse-error.ts";

test("extractSseError returns null for chunks without an error", () => {
  assert.equal(extractSseError(null), null);
  assert.equal(extractSseError("nope"), null);
  assert.equal(extractSseError({ choices: [{ delta: { content: "hi" } }] }), null);
});

test("extractSseError normalizes object, string and missing codes", () => {
  assert.deepEqual(
    extractSseError({
      error: { message: "boom", type: "rate_limit_error", code: "quota_limit" },
    }),
    { message: "boom", code: "quota_limit", type: "rate_limit_error" },
  );

  assert.deepEqual(extractSseError({ error: "plain failure" }), {
    message: "plain failure",
    code: "upstream_error",
  });

  assert.deepEqual(
    extractSseError({ error: { message: "no code", type: "upstream_error" } }),
    { message: "no code", code: "upstream_error", type: "upstream_error" },
  );

  assert.deepEqual(extractSseError({ error: {} }), {
    message: "Upstream stream error",
    code: "upstream_error",
  });
});

test("extractSseError ignores array/non-object error payloads", () => {
  assert.equal(extractSseError({ error: [1, 2] }), null);
  assert.equal(extractSseError({ error: 42 }), null);
});

test("statusForSseError classifies common upstream failures", () => {
  assert.equal(statusForSseError({ message: "", code: "quota_limit" }), 429);
  assert.equal(
    statusForSseError({ message: "", code: "rate_limit_exceeded" }),
    429,
  );
  assert.equal(statusForSseError({ message: "", code: "not_found" }), 404);
  assert.equal(statusForSseError({ message: "", code: "invalid_input" }), 400);
  assert.equal(statusForSseError({ message: "", code: "stream_error" }), 502);
});
