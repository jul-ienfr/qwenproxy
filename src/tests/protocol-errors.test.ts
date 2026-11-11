import test from "node:test";
import assert from "node:assert/strict";

process.env.API_KEY = "";

import { app } from "../api/server.ts";

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(
    app.fetch(new Request(`http://localhost${path}`, { headers })),
  );
}

test("protocol errors: unmatched Gemini paths keep the Gemini envelope", async () => {
  const res = await get("/v1beta/not-a-route");
  assert.equal(res.status, 404);
  const body = (await res.json()) as {
    error: { code: number; status: string; message: string };
  };
  assert.equal(body.error.code, 404);
  assert.equal(body.error.status, "NOT_FOUND");
  assert.match(body.error.message, /not found/i);
});

test("protocol errors: unmatched Anthropic paths keep the Anthropic envelope", async () => {
  const res = await get("/v1/messages/not-a-route");
  assert.equal(res.status, 404);
  const body = (await res.json()) as {
    type: string;
    error: { type: string; message: string };
    request_id: string;
  };
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "not_found_error");
  assert.match(body.error.message, /not found/i);
  assert.match(body.request_id, /^req_/);
});

test("protocol errors: an anthropic-version header selects the Anthropic envelope", async () => {
  const res = await get("/v1/not-a-route", {
    "anthropic-version": "2023-06-01",
  });
  assert.equal(res.status, 404);
  const body = (await res.json()) as {
    type: string;
    error: { type: string };
  };
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "not_found_error");
  assert.equal(res.headers.get("anthropic-version"), "2023-06-01");
});

test("protocol errors: unmatched OpenAI paths keep the OpenAI envelope", async () => {
  const res = await get("/v1/not-a-route");
  assert.equal(res.status, 404);
  const body = (await res.json()) as {
    error: { type: string; code: string; message: string };
  };
  assert.equal(body.error.type, "not_found_error");
  assert.equal(body.error.code, "resource_not_found");
  assert.match(body.error.message, /not found/i);
});
