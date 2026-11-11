import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { app } from "../api/server.ts";

const modelsPayload = {
  data: [
    {
      id: "qwen-test-model",
      owned_by: "qwen",
      info: {
        created_at: 123,
        is_active: true,
        meta: {
          max_context_length: 4096,
          max_summary_generation_length: 2048,
          capabilities: { thinking: true, vision: true, search: true },
          modality: ["text", "image"],
          chat_type: ["t2t", "t2i"],
          think_skip: { enable: true },
          mcp: ["code-interpreter"],
        },
      },
    },
    {
      id: "qwen-text-only-model",
      owned_by: "qwen",
      info: {
        created_at: 124,
        meta: {
          max_context_length: 8192,
          max_thinking_generation_length: 4096,
          max_summary_generation_length: 2048,
          capabilities: { thinking: true },
          modality: ["text"],
          chat_type: ["t2t", "t2i", "t2v"],
        },
      },
    },
  ],
};

function installModelsFetchMock(): typeof globalThis.fetch {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/models")) {
      return new Response(JSON.stringify(modelsPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
  return originalFetch;
}

test("models endpoint returns ETag and supports 304", async () => {
  const originalFetch = installModelsFetchMock();
  try {
    const first = await app.fetch(new Request("http://localhost/v1/models"));
    assert.equal(first.status, 200);
    const etag = first.headers.get("etag");
    assert.ok(etag, "ETag should be set");

    const body = (await first.json()) as any;
    assert.equal(body.object, "list");
    assert.ok(body.data.some((model: any) => model.id === "qwen-test-model"));
    assert.ok(body.data.some((model: any) => model.id === "qwen-text-only-model"));
    assert.equal(
      body.data.some((m: any) => m.id.endsWith("-fast") || m.id.endsWith("-thinking")),
      false,
      "synthetic -fast and -thinking variants must not be published",
    );
    assert.equal(
      body.data.some((m: any) => m.id.endsWith("-search")),
      false,
      "synthetic -search variants must not be published",
    );
    const searchModel = body.data.find(
      (model: any) => model.id === "qwen-test-model",
    );
    assert.equal(searchModel.supports_search, true);
    const nonSearchModel = body.data.find(
      (model: any) => model.id === "qwen-text-only-model",
    );
    assert.equal(nonSearchModel.supports_search, false);
    assert.equal(
      body.data.filter((model: any) => model.id === "qwen-test-model").length,
      1,
    );
    const liveMetadata = body.data.find(
      (model: any) => model.id === "qwen-test-model",
    );
    assert.equal(liveMetadata.info.meta.max_summary_generation_length, 2048);
    assert.deepEqual(liveMetadata.modality, ["text", "image"]);

    const second = await app.fetch(
      new Request("http://localhost/v1/models", {
        headers: { "If-None-Match": etag! },
      }),
    );
    assert.equal(second.status, 304);
    assert.equal(second.headers.get("etag"), etag);
    assert.equal(
      second.headers.get("cache-control"),
      "public, max-age=3600",
    );
    assert.ok(
      second.headers.get("vary")?.includes("anthropic-version"),
      "the protocol header must be part of the cache key",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("models endpoint renders and caches the Anthropic shape separately", async () => {
  const originalFetch = installModelsFetchMock();
  try {
    const openai = await app.fetch(new Request("http://localhost/v1/models"));
    const openaiEtag = openai.headers.get("etag");
    assert.ok(openaiEtag);

    const anthropic = await app.fetch(
      new Request("http://localhost/v1/models", {
        headers: { "anthropic-version": "2023-06-01" },
      }),
    );
    assert.equal(anthropic.status, 200);
    const body = (await anthropic.json()) as {
      data: Array<{ id: string; type: string }>;
      has_more: boolean;
    };
    assert.equal(body.has_more, false);
    assert.ok(body.data.some((model) => model.id === "qwen-test-model"));
    assert.equal(body.data[0]?.type, "model");
    assert.notEqual(
      anthropic.headers.get("etag"),
      openaiEtag,
      "the ETag must not validate the other response shape",
    );
    assert.ok(
      anthropic.headers.get("vary")?.includes("anthropic-version"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("models endpoint returns a single model and 404 for missing model", async () => {
  const originalFetch = installModelsFetchMock();
  try {
    const found = await app.fetch(
      new Request("http://localhost/v1/models/qwen-test-model"),
    );
    assert.equal(found.status, 200);
    const model = (await found.json()) as any;
    assert.equal(model.id, "qwen-test-model");

    const etag = found.headers.get("etag");
    assert.ok(etag, "single-model responses must carry an ETag");
    assert.equal(
      found.headers.get("cache-control"),
      "public, max-age=3600",
    );
    assert.ok(found.headers.get("vary")?.includes("anthropic-version"));

    const revalidated = await app.fetch(
      new Request("http://localhost/v1/models/qwen-test-model", {
        headers: { "If-None-Match": etag! },
      }),
    );
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.headers.get("etag"), etag);

    const anthropicShape = await app.fetch(
      new Request("http://localhost/v1/models/qwen-test-model", {
        headers: { "anthropic-version": "2023-06-01" },
      }),
    );
    assert.equal(anthropicShape.status, 200);
    assert.notEqual(
      anthropicShape.headers.get("etag"),
      etag,
      "the ETag must not validate the other protocol shape",
    );

    const missing = await app.fetch(
      new Request("http://localhost/v1/models/not-a-model"),
    );
    assert.equal(missing.status, 404);
    const error = (await missing.json()) as any;
    assert.equal(error.error.code, "resource_not_found");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("models endpoint falls back gracefully to default models when upstream auth/network fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/models")) {
      return new Response(JSON.stringify({ success: false, code: "Unauthorized", details: "Session expired" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;

  try {
    const res = await app.fetch(new Request("http://localhost/v1/models"));
    assert.equal(res.status, 200, "Must return 200 with fallback models instead of 401");
    const body = (await res.json()) as any;
    assert.equal(body.object, "list");
    assert.ok(body.data.length > 0, "Must return models list");
    assert.ok(body.data.some((m: any) => m.id === "qwen-test-model" || m.id === "qwen3.8-max"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
