import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.API_KEY = "";

import { app } from "../api/server.ts";

function errorStreamResponse(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"error":{"message":"upstream exploded","type":"upstream_error","code":"stream_error"}}\n\n',
        ),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function withStubbedFetch<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => errorStreamResponse()) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function dataFrames(text: string): any[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .filter((data) => data && data !== "[DONE]")
    .flatMap((data) => {
      try {
        return [JSON.parse(data)];
      } catch {
        return [];
      }
    });
}

test("Anthropic stream surfaces an upstream error frame instead of message_stop", async () => {
  const text = await withStubbedFetch(async () => {
    const res = await app.fetch(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "sk-dummy",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "qwen3.7-plus",
          max_tokens: 64,
          messages: [{ role: "user", content: "ping" }],
          stream: true,
        }),
      }),
    );
    assert.equal(res.status, 200);
    return res.text();
  });

  assert.match(text, /event: error/);
  assert.match(text, /upstream exploded/);
  assert.doesNotMatch(text, /event: message_stop/);
});

test("Gemini stream surfaces an upstream error frame instead of a STOP candidate", async () => {
  const text = await withStubbedFetch(async () => {
    const res = await app.fetch(
      new Request(
        "http://localhost/v1beta/models/qwen3.7-plus:streamGenerateContent",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": "sk-dummy",
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "ping" }] }],
          }),
        },
      ),
    );
    assert.equal(res.status, 200);
    return res.text();
  });

  const frames = dataFrames(text);
  const failure = frames.find((frame) => frame.error);
  assert.ok(failure, "an error frame must be emitted");
  assert.equal(failure.error.message, "upstream exploded");
  assert.ok(
    !frames.some((frame) => frame.candidates?.[0]?.finishReason === "STOP"),
    "must not finalize the failed stream as a successful STOP",
  );
});

test("Responses stream reports response.failed for an upstream error frame", async () => {
  const text = await withStubbedFetch(async () => {
    const res = await app.fetch(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.7-plus",
          input: "ping",
          stream: true,
        }),
      }),
    );
    assert.equal(res.status, 200);
    return res.text();
  });

  assert.match(text, /event: response.failed/);
  assert.match(text, /upstream exploded/);
  assert.doesNotMatch(text, /event: response.completed/);
});

test("Legacy completions stream emits an error chunk for an upstream error frame", async () => {
  const text = await withStubbedFetch(async () => {
    const res = await app.fetch(
      new Request("http://localhost/v1/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "qwen3.7-plus",
          prompt: "ping",
          stream: true,
        }),
      }),
    );
    assert.equal(res.status, 200);
    return res.text();
  });

  const frames = dataFrames(text);
  const failure = frames.find((frame) => frame.error);
  assert.ok(failure, "an error chunk must be emitted");
  assert.equal(failure.error.message, "upstream exploded");
  assert.match(text, /data: \[DONE\]/);
});
