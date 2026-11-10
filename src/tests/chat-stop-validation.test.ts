import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.API_KEY = "";

import { app } from "../api/server.ts";

function stopRequest(body: string | object): Request {
  return new Request("http://localhost/v1/chat/completions/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("POST /v1/chat/completions/stop rejects malformed JSON with 400", async () => {
  const response = await app.fetch(stopRequest("{"));
  assert.equal(response.status, 400);
  const body = (await response.json()) as any;
  assert.equal(body.error.type, "invalid_request_error");
  assert.match(body.error.message, /Invalid JSON body/);
});

test("POST /v1/chat/completions/stop rejects non-object bodies with 400", async () => {
  for (const body of ["null", "[]", '"text"', "42"]) {
    const response = await app.fetch(stopRequest(body));
    assert.equal(response.status, 400);
    const parsed = (await response.json()) as any;
    assert.equal(parsed.error.type, "invalid_request_error");
    assert.match(parsed.error.message, /JSON object/);
  }
});

test("POST /v1/chat/completions/stop requires string ids", async () => {
  for (const body of [
    {},
    { chat_id: 1, response_id: 2 },
    { chat_id: "chat", response_id: "" },
  ]) {
    const response = await app.fetch(stopRequest(body));
    assert.equal(response.status, 400);
    const parsed = (await response.json()) as any;
    assert.equal(parsed.error.type, "invalid_request_error");
    assert.equal(parsed.error.param, "chat_id");
  }
});

test("POST /v1/chat/completions/stop returns 404 for an unknown stream", async () => {
  const response = await app.fetch(
    stopRequest({ chat_id: "missing-chat-stop-test", response_id: "missing-resp" }),
  );
  assert.equal(response.status, 404);
  const body = (await response.json()) as any;
  assert.equal(body.error.message, "Stream not found");
});
