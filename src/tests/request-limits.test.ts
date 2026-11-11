import test from "node:test";
import assert from "node:assert/strict";

process.env.API_KEY = "";

import { app } from "../api/server.ts";

const OVERSIZED_BODY = "x".repeat(33 * 1024 * 1024 + 1);

function post(
  path: string,
  body: string,
  contentType: string,
): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      }),
    ),
  );
}

test("limits: oversized JSON requests get a protocol-native OpenAI 413", async () => {
  const res = await post(
    "/v1/chat/completions",
    OVERSIZED_BODY,
    "application/json",
  );
  assert.equal(res.status, 413);
  const body = (await res.json()) as {
    error: { code: string; type: string; message: string };
  };
  assert.equal(body.error.code, "request_too_large");
  assert.equal(body.error.type, "invalid_request_error");
  assert.match(body.error.message, /allowed size/i);
});

test("limits: oversized Gemini requests keep the Gemini error envelope", async () => {
  const res = await post(
    "/v1beta/models/qwen3:generateContent",
    OVERSIZED_BODY,
    "application/json",
  );
  assert.equal(res.status, 413);
  const body = (await res.json()) as {
    error: { code: number; status: string };
  };
  assert.equal(body.error.code, 413);
  assert.equal(body.error.status, "RESOURCE_EXHAUSTED");
});

test("limits: oversized Anthropic requests keep the Anthropic error envelope", async () => {
  const res = await post(
    "/v1/messages",
    OVERSIZED_BODY,
    "application/json",
  );
  assert.equal(res.status, 413);
  const body = (await res.json()) as {
    type: string;
    error: { type: string; message: string };
  };
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "request_too_large");
  assert.match(body.error.message, /allowed size/i);
});

test("limits: admin login bodies are capped at 1 MB", async () => {
  const res = await post(
    "/admin/api/session",
    "x".repeat(1024 * 1024 + 1),
    "application/json",
  );
  assert.equal(res.status, 413);
  const body = (await res.json()) as {
    error: { type: string; message: string };
  };
  assert.equal(body.error.type, "invalid_request_error");
  assert.match(body.error.message, /allowed size/i);
});
