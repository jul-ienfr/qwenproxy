import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.MODEL_MAP = "";

import { app } from "../api/server.ts";
import { getModelMappingsPath } from "../core/paths.ts";
import {
  findExactModelMapping,
  getModelMappingFallback,
  getModelMappingState,
  parseModelMap,
  resetModelMappings,
  saveModelMappings,
  validateModelMappings,
} from "../core/model-mapping.ts";
import { mapClientModelToQwen } from "../core/model-alias.ts";
import { mapAnthropicModel } from "../routes/anthropic/translate.ts";
import { mapGeminiModel } from "../routes/gemini/translate.ts";

const MAPPING_FILE = getModelMappingsPath();

function clearMappingFile(): void {
  try {
    fs.unlinkSync(MAPPING_FILE);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function jsonRequest(body: unknown, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return { ...init, headers, body: JSON.stringify(body) };
}

function installModelsFetchMock(): () => void {
  const originalFetch = globalThis.fetch;
  const payload = {
    data: [
      {
        id: "qwen3.8-max",
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
          },
        },
      },
      {
        id: "qwen3.7-plus",
        owned_by: "qwen",
        info: {
          created_at: 124,
          is_active: true,
          meta: {
            max_context_length: 8192,
            max_summary_generation_length: 2048,
            capabilities: { thinking: true },
            modality: ["text"],
            chat_type: ["t2t"],
          },
        },
      },
    ],
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/models")) {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

beforeEach(() => {
  process.env.MODEL_MAP = "";
  resetModelMappings();
  clearMappingFile();
});

after(() => {
  try {
    resetModelMappings();
  } catch {}
  clearMappingFile();
});

test("parseModelMap: parses exact aliases and wildcard fallback", () => {
  const parsed = parseModelMap(
    " gpt-4o = qwen3.8-max , claude-sonnet=qwen3.8-max, *= qwen3.7-plus ",
  );
  assert.deepEqual(
    parsed.mappings.map((entry) => [entry.alias, entry.target]),
    [
      ["gpt-4o", "qwen3.8-max"],
      ["claude-sonnet", "qwen3.8-max"],
    ],
  );
  assert.equal(parsed.fallback, "qwen3.7-plus");
  assert.deepEqual(parsed.errors, []);
});

test("parseModelMap: reports malformed and duplicate entries", () => {
  const parsed = parseModelMap(
    "missing-equals, empty-target=, =empty-alias, dup=a, DUP=b, *=x, *=y",
  );
  assert.equal(parsed.mappings.length, 1);
  assert.equal(parsed.fallback, "x");
  assert.ok(parsed.errors.length >= 5);
  assert.ok(parsed.errors.some((error) => /expected alias=target/.test(error)));
  assert.ok(parsed.errors.some((error) => /duplicate alias/.test(error)));
  assert.ok(
    parsed.errors.some((error) => /wildcard fallback.*more than once/.test(error)),
  );
});

test("validateModelMappings: rejects invalid aliases and chains", () => {
  assert.equal(
    validateModelMappings(
      [{ alias: "gpt-4o", target: "qwen3.8-max" }],
      "qwen3.7-plus",
    ).valid,
    true,
  );

  const cases: Array<{
    mappings: Array<{ alias: string; target: string }>;
    fallback?: string | null;
  }> = [
    { mappings: [{ alias: "qwen3.8-max", target: "qwen3.7-plus" }] },
    { mappings: [{ alias: "wan2.7-image", target: "qwen3.8-max" }] },
    { mappings: [{ alias: "gpt-4o-high", target: "qwen3.8-max" }] },
    { mappings: [{ alias: "gpt 4o", target: "qwen3.8-max" }] },
    { mappings: [{ alias: "gpt-4o", target: "" }] },
    {
      mappings: [
        { alias: "a", target: "b" },
        { alias: "b", target: "qwen3.8-max" },
      ],
    },
    {
      mappings: [
        { alias: "a", target: "qwen3.8-max" },
        { alias: "A", target: "qwen3.7-plus" },
      ],
    },
    {
      mappings: [{ alias: "a", target: "qwen3.8-max" }],
      fallback: "a",
    },
  ];

  for (const entry of cases) {
    const result = validateModelMappings(
      entry.mappings,
      entry.fallback ?? null,
    );
    assert.equal(result.valid, false, JSON.stringify(entry));
    assert.ok(result.errors.length > 0);
  }
});

test("saveModelMappings: persists atomically and resolves case-insensitively", () => {
  const state = saveModelMappings({
    mappings: [{ alias: "gpt-4o", target: "qwen3.5-plus" }],
    fallback: "qwen3.7-plus",
  });

  assert.equal(state.source, "file");
  assert.equal(state.updatedAt !== null, true);
  assert.ok(fs.existsSync(MAPPING_FILE));
  const persisted = JSON.parse(fs.readFileSync(MAPPING_FILE, "utf-8"));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.mappings[0].alias, "gpt-4o");

  assert.equal(findExactModelMapping("GPT-4O")?.target, "qwen3.5-plus");
  assert.equal(findExactModelMapping("missing"), undefined);
  assert.equal(getModelMappingFallback("totally-custom"), "qwen3.7-plus");
  assert.equal(getModelMappingFallback("qwen3.8-max"), undefined);
  assert.equal(getModelMappingFallback("wan2.7-image"), undefined);
});

test("model mappings: external file edits are picked up without restart", () => {
  saveModelMappings({
    mappings: [{ alias: "gpt-4o", target: "qwen3.5-plus" }],
    fallback: null,
  });
  assert.equal(findExactModelMapping("gpt-4o")?.target, "qwen3.5-plus");

  const now = new Date().toISOString();
  fs.writeFileSync(
    MAPPING_FILE,
    JSON.stringify({
      version: 1,
      mappings: [{ alias: "custom", target: "qwen3.8-max", updatedAt: now }],
      fallback: null,
      updatedAt: now,
    }),
  );
  const bumped = new Date(Date.now() + 2000);
  fs.utimesSync(MAPPING_FILE, bumped, bumped);

  assert.equal(findExactModelMapping("custom")?.target, "qwen3.8-max");
  assert.equal(findExactModelMapping("gpt-4o"), undefined);
  assert.equal(mapClientModelToQwen("custom"), "qwen3.8-max");
});

test("mapClientModelToQwen: exact > built-in > wildcard > passthrough", () => {
  saveModelMappings({
    mappings: [
      { alias: "gpt-4o", target: "qwen3.5-plus" },
      { alias: "custom", target: "qwen3.5-omni-plus" },
    ],
    fallback: "qwen3.6-plus",
  });

  assert.equal(mapClientModelToQwen("gpt-4o"), "qwen3.5-plus");
  assert.equal(mapClientModelToQwen("GPT-4O"), "qwen3.5-plus");
  assert.equal(mapClientModelToQwen("gpt-4o-high"), "qwen3.5-plus");
  assert.equal(mapClientModelToQwen("gpt-4o", false), "qwen3.5-plus");

  // Built-in family alias wins over the wildcard.
  assert.equal(mapClientModelToQwen("gpt-4o-mini"), "qwen3.7-plus");
  assert.equal(mapClientModelToQwen("claude-sonnet"), "qwen3.8-max");

  assert.equal(mapClientModelToQwen("custom"), "qwen3.5-omni-plus");
  assert.equal(mapClientModelToQwen("totally-custom"), "qwen3.6-plus");

  // Upstream-native ids are never rewritten by the wildcard.
  assert.equal(mapClientModelToQwen("qwen3.8-max"), "qwen3.8-max");
  assert.equal(mapClientModelToQwen("qwen3.7-plus-low"), "qwen3.7-plus");
  assert.equal(mapClientModelToQwen("wan2.7-image"), "wan2.7-image");
  assert.equal(mapClientModelToQwen("z-image-turbo"), "z-image-turbo");
});

test("mapAnthropicModel: runtime aliases beat family logic and keep suffixes", () => {
  saveModelMappings({
    mappings: [
      { alias: "claude-sonnet", target: "qwen3.5-plus" },
      { alias: "gpt-4o", target: "qwen3.6-plus" },
    ],
    fallback: "qwen3.7-plus",
  });

  assert.equal(mapAnthropicModel("claude-sonnet"), "qwen3.5-plus");
  assert.equal(mapAnthropicModel("claude-sonnet-thinking"), "qwen3.5-plus-thinking");
  assert.equal(mapAnthropicModel("gpt-4o-fast"), "qwen3.6-plus-fast");
  assert.equal(mapAnthropicModel("claude-opus"), "qwen3.8-max");
  assert.equal(mapAnthropicModel("claude-haiku"), "qwen3.7-plus");
  assert.equal(mapAnthropicModel("custom-model"), "qwen3.7-plus");
  assert.equal(mapAnthropicModel("qwen3.8-max"), "qwen3.8-max");
  assert.equal(mapAnthropicModel("wan2.7-image"), "wan2.7-image");
});

test("mapGeminiModel: shares runtime precedence with the other protocols", () => {
  saveModelMappings({
    mappings: [{ alias: "gpt-4o", target: "qwen3.5-plus" }],
    fallback: "qwen3.7-plus",
  });

  assert.equal(mapGeminiModel("models/gpt-4o"), "qwen3.5-plus");
  assert.equal(mapGeminiModel("gpt-4o-fast"), "qwen3.5-plus-fast");
  assert.equal(mapGeminiModel("gpt-4o-search"), "qwen3.5-plus-search");
  assert.equal(mapGeminiModel("totally-custom"), "qwen3.7-plus");
  assert.equal(mapGeminiModel("qwen3.8-max"), "qwen3.8-max");
});

test("admin API: mappings can be read, replaced, and reset", async () => {
  const initial = await app.request("/admin/api/model-mappings");
  assert.equal(initial.status, 200);
  const initialBody = (await initial.json()) as any;
  assert.deepEqual(initialBody.mappings, {});
  assert.equal(initialBody.fallback, null);

  const put = await app.request(
    "/admin/api/model-mappings",
    jsonRequest(
      {
        map: "gpt-4o=qwen3.8-max,claude-sonnet=qwen3.5-plus,*=qwen3.7-plus",
      },
      { method: "PUT" },
    ),
  );
  assert.equal(put.status, 200);
  const putBody = (await put.json()) as any;
  assert.deepEqual(putBody.mappings, {
    "gpt-4o": "qwen3.8-max",
    "claude-sonnet": "qwen3.5-plus",
  });
  assert.equal(putBody.fallback, "qwen3.7-plus");
  assert.equal(putBody.source, "file");

  const read = await app.request("/admin/api/model-mappings");
  const readBody = (await read.json()) as any;
  assert.deepEqual(readBody.mappings, putBody.mappings);
  assert.equal(readBody.fallback, "qwen3.7-plus");

  const objectPut = await app.request(
    "/admin/api/model-mappings",
    jsonRequest(
      { mappings: { "gpt-4o": "qwen3.5-plus" }, fallback: null },
      { method: "PUT" },
    ),
  );
  assert.equal(objectPut.status, 200);
  const objectBody = (await objectPut.json()) as any;
  assert.deepEqual(objectBody.mappings, { "gpt-4o": "qwen3.5-plus" });
  assert.equal(objectBody.fallback, null);

  const removed = await app.request("/admin/api/model-mappings", {
    method: "DELETE",
  });
  assert.equal(removed.status, 200);
  const removedBody = (await removed.json()) as any;
  assert.deepEqual(removedBody.mappings, {});
  assert.equal(removedBody.fallback, null);
  assert.equal(fs.existsSync(MAPPING_FILE), false);
});

test("admin API: invalid mappings are rejected with actionable errors", async () => {
  const invalidPayloads = [
    { map: "gpt-4o=qwen3.8-max,gpt-4o=qwen3.5-plus" },
    { map: "qwen3.8-max=qwen3.5-plus" },
    { map: "gpt-4o=" },
    { mappings: { "gpt-4o": "" } },
    { mappings: { a: "b", b: "qwen3.8-max" } },
    { mappings: { "gpt-4o-high": "qwen3.8-max" } },
    {},
  ];

  for (const payload of invalidPayloads) {
    const response = await app.request(
      "/admin/api/model-mappings",
      jsonRequest(payload, { method: "PUT" }),
    );
    assert.equal(response.status, 400, JSON.stringify(payload));
    const body = (await response.json()) as any;
    assert.equal(typeof body.error.message, "string");
    assert.ok(body.error.message.length > 0);
  }

  const malformed = await app.request("/admin/api/model-mappings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });
  assert.equal(malformed.status, 400);

  // A failed save must not overwrite the previous valid mapping.
  assert.equal(getModelMappingState().source, "default");
});

test("admin API: mapping changes are audited", async () => {
  await app.request(
    "/admin/api/model-mappings",
    jsonRequest({ map: "gpt-4o=qwen3.8-max" }, { method: "PUT" }),
  );

  const audit = await app.request("/admin/api/audit?limit=50");
  assert.equal(audit.status, 200);
  const body = (await audit.json()) as any;
  assert.ok(
    body.records.some(
      (record: any) =>
        record.action === "model_mappings.update" &&
        record.result === "ok" &&
        record.target.includes("gpt-4o"),
    ),
  );
});

test("models catalog: aliases expose the target context and capabilities", async () => {
  const restore = installModelsFetchMock();
  try {
    await app.request(
      "/admin/api/model-mappings",
      jsonRequest(
        { map: "gpt-4o=qwen3.8-max,claude-sonnet=qwen3.7-plus" },
        { method: "PUT" },
      ),
    );

    const first = await app.request("/v1/models");
    assert.equal(first.status, 200);
    const firstEtag = first.headers.get("etag");
    assert.ok(firstEtag);
    const firstBody = (await first.json()) as any;

    const alias = firstBody.data.find((model: any) => model.id === "gpt-4o");
    assert.ok(alias, "alias must be published in /v1/models");
    assert.equal(alias.mapped_to, "qwen3.8-max");
    assert.equal(alias.context_window, 4096);
    assert.equal(alias.supports_search, true);

    const aliasByPath = await app.request("/v1/models/gpt-4o");
    assert.equal(aliasByPath.status, 200);
    const aliasModel = (await aliasByPath.json()) as any;
    assert.equal(aliasModel.mapped_to, "qwen3.8-max");

    const anthropic = await app.request("/v1/models", {
      headers: { "anthropic-version": "2023-06-01" },
    });
    assert.equal(anthropic.status, 200);
    const anthropicBody = (await anthropic.json()) as any;
    const anthropicAlias = anthropicBody.data.find(
      (model: any) => model.id === "gpt-4o",
    );
    assert.ok(anthropicAlias);
    assert.equal(anthropicAlias.max_input_tokens, 4096);

    const updated = await app.request(
      "/admin/api/model-mappings",
      jsonRequest(
        { mappings: { "gpt-4o": "qwen3.7-plus" }, fallback: null },
        { method: "PUT" },
      ),
    );
    assert.equal(updated.status, 200);

    const second = await app.request("/v1/models");
    assert.equal(second.status, 200);
    assert.notEqual(second.headers.get("etag"), firstEtag);
    const secondBody = (await second.json()) as any;
    const updatedAlias = secondBody.data.find(
      (model: any) => model.id === "gpt-4o",
    );
    assert.equal(updatedAlias.mapped_to, "qwen3.7-plus");
    assert.equal(updatedAlias.context_window, 8192);
    assert.equal(
      secondBody.data.some((model: any) => model.id === "claude-sonnet"),
      false,
      "removed aliases must disappear from the catalog",
    );
  } finally {
    restore();
  }
});
