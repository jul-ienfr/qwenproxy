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

/** A dispatch failure that carries the upstream HTTP status it represents. */
function hintedFetchFailure(status: number, message: string): typeof fetch {
  return (async () => {
    const error = new Error(message) as Error & { upstreamStatus?: number };
    error.upstreamStatus = status;
    throw error;
  }) as typeof fetch;
}

async function withFetch<T>(
  replacement: typeof fetch,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = replacement;
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

test("Anthropic stream propagates the pre-stream upstream error message and type", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: { message: "bad request detail", type: "invalid_request_error" },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
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
    const text = await res.text();
    assert.match(text, /event: error/);
    assert.match(text, /bad request detail/);
    assert.match(text, /invalid_request_error/);
    assert.doesNotMatch(text, /event: message_stop/);
  } finally {
    globalThis.fetch = original;
  }
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

test("Responses stream preserves the inner error code on a pre-stream failure", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          message: "quota gone",
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
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
    const frames = dataFrames(await res.text());
    const failure = frames.find((frame) => frame.type === "response.failed");
    assert.ok(failure, "a response.failed event must be emitted");
    assert.equal(failure.response.status, "failed");
    assert.equal(failure.response.error.code, "rate_limit_exceeded");
    assert.equal(failure.response.error.message, "quota gone");
  } finally {
    globalThis.fetch = original;
  }
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

test("Legacy completions stream terminates when the upstream body fails mid-stream", async () => {
  const original = globalThis.fetch;
  let pulls = 0;
  globalThis.fetch = (async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
            ),
          );
          return;
        }
        controller.error(new Error("socket reset"));
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  try {
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

    // Without an explicit close the response would hang forever; the timeout
    // proves the route terminates the stream after a read failure.
    const text = await Promise.race([
      res.text(),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("stream did not terminate")), 2000),
      ),
    ]);

    const frames = dataFrames(text);
    const failure = frames.find((frame) => frame.error);
    assert.ok(failure, "a terminal error chunk must be emitted");
    assert.match(failure.error.message, /socket reset/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    globalThis.fetch = original;
  }
});

test("Anthropic non-stream propagates an upstream status hint", async () => {
  const res = await withFetch(
    hintedFetchFailure(404, "model not found upstream"),
    async () =>
      app.fetch(
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
          }),
        }),
      ),
  );

  assert.equal(res.status, 404);
  const json = (await res.json()) as any;
  assert.equal(json.error.type, "not_found_error");
  assert.match(json.error.message, /model not found upstream/);
});

test("Anthropic stream error events use the hinted upstream status", async () => {
  const res = await withFetch(
    hintedFetchFailure(404, "model not found upstream"),
    async () =>
      app.fetch(
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
      ),
  );

  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /event: error/);
  assert.match(text, /not_found_error/);
  assert.match(text, /model not found upstream/);
});

test("Gemini non-stream propagates an upstream status hint", async () => {
  const res = await withFetch(
    hintedFetchFailure(404, "model not found upstream"),
    async () =>
      app.fetch(
        new Request(
          "http://localhost/v1beta/models/qwen3.7-plus:generateContent",
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
      ),
  );

  assert.equal(res.status, 404);
  const json = (await res.json()) as any;
  assert.equal(json.error.code, 404);
  assert.equal(json.error.status, "NOT_FOUND");
  assert.match(json.error.message, /model not found upstream/);
});

test("Gemini stream error frames use the hinted upstream status", async () => {
  const res = await withFetch(
    hintedFetchFailure(404, "model not found upstream"),
    async () =>
      app.fetch(
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
      ),
  );

  assert.equal(res.status, 200);
  const frames = dataFrames(await res.text());
  const failure = frames.find((frame) => frame.error);
  assert.ok(failure, "an error frame must be emitted");
  assert.equal(failure.error.code, 404);
  assert.equal(failure.error.status, "NOT_FOUND");
  assert.match(failure.error.message, /model not found upstream/);
});
