import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.API_KEY = "";

import { app } from "../api/server.ts";
import { config } from "../core/config.ts";
import {
  createVideoTask,
  getVideoTask,
  resetVideoTasksForTests,
} from "../core/video-tasks.ts";
import {
  looksLikeAntiBotChallengeText,
  shortMediaId,
  mediaLog,
  isSupportedMediaSize,
  supportsPromptMediaGeneration,
  resolveMediaModel,
  classifyMediaModel,
  getMediaModelModes,
  listMediaGenerationModels,
  MEDIA_SIZE_OPTIONS,
} from "../services/media-generation.ts";

test("Media Generation Utils: looksLikeAntiBotChallengeText detects challenge markers", () => {
  assert.equal(looksLikeAntiBotChallengeText(""), false);
  assert.equal(looksLikeAntiBotChallengeText("Here is your cyberpunk image result"), false);
  assert.equal(looksLikeAntiBotChallengeText("Error: FAIL_SYS_USER_VALIDATE"), true);
  assert.equal(looksLikeAntiBotChallengeText("rgv587_error detected in response"), true);
  assert.equal(looksLikeAntiBotChallengeText("Please complete the baxia puzzle"), true);
  assert.equal(looksLikeAntiBotChallengeText("_____tmd_____ token challenge"), true);
  assert.equal(looksLikeAntiBotChallengeText("security verification required"), true);
  assert.equal(looksLikeAntiBotChallengeText("human verification failed"), true);
  assert.equal(looksLikeAntiBotChallengeText("denyfromx5 rule triggered"), true);
  assert.equal(looksLikeAntiBotChallengeText('<meta name="aliyun_waf_aa" content="xyz">'), true);
  assert.equal(looksLikeAntiBotChallengeText('appkey: "CF_APP_WAF"'), true);
  assert.equal(looksLikeAntiBotChallengeText('<!doctype html><html><body>challenge</body></html>'), true);
});

test("Media Generation Utils: shortMediaId and mediaLog helper formatting", () => {
  assert.equal(shortMediaId("123456789012345", 8), "12345678");
  assert.equal(shortMediaId("short", 10), "short");

  const imageLog = mediaLog("image", "generate", {
    model: "qwen-image-3.0-pro",
    url: "https://secret.oss.aliyuncs.com/file.png?token=123",
  });
  assert.ok(imageLog.includes("🎨"));
  assert.ok(imageLog.includes("generate"));
  assert.ok(imageLog.includes("[redacted-url]"), "URLs must be redacted from media log output");

  const videoLog = mediaLog("video", "poll", { taskId: "task_123" });
  assert.ok(videoLog.includes("🎬"));
  assert.ok(videoLog.includes("taskId=task_123"));
});

test("Media Generation Capabilities: media size validation and model classification", () => {
  for (const size of MEDIA_SIZE_OPTIONS) {
    assert.equal(isSupportedMediaSize(size), true);
  }
  assert.equal(isSupportedMediaSize("invalid_size"), false);
  assert.equal(isSupportedMediaSize(null), false);
  assert.equal(isSupportedMediaSize(123), false);

  // Model classification
  assert.equal(classifyMediaModel("qwen-image-3.0-pro"), "image");
  assert.equal(classifyMediaModel("wan2.7-image-pro"), "image");
  assert.equal(classifyMediaModel("wan3.0-video"), "video");
  assert.equal(classifyMediaModel("wan2.7-t2v"), "video");
  assert.equal(classifyMediaModel("qwen3.7-plus"), null);
  assert.equal(classifyMediaModel(null), null);

  // Prompt media generation support
  assert.equal(supportsPromptMediaGeneration("qwen-image-3.0-pro", "image"), true);
  assert.equal(supportsPromptMediaGeneration("wan3.0-video", "video"), true);
  assert.equal(supportsPromptMediaGeneration("wan2.7-i2v", "video"), false);
  assert.equal(supportsPromptMediaGeneration("wan3.0-video", "image"), false);

  // Resolution and catalog modes
  const resolved = resolveMediaModel("qwen-image-3.0-pro");
  assert.ok(resolved.chatModel);
  assert.equal(resolved.generationModel, "qwen-image-3.0-pro");

  const modes = getMediaModelModes("qwen-image-3.0-pro");
  assert.ok(Array.isArray(modes));
  assert.ok(modes.length > 0);

  const allModels = listMediaGenerationModels();
  assert.ok(Array.isArray(allModels));
  assert.ok(allModels.some((m) => m.kind === "image"));
  assert.ok(allModels.some((m) => m.kind === "video"));
});

test("Images Generations Route: validates input parameters according to OpenAI spec", async () => {
  // 1. Invalid JSON body
  let res = await app.fetch(
    new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "NOT_JSON",
    }),
  );
  assert.equal(res.status, 400);

  // 1b. Non-object bodies must be a 400, not a crash on `body.prompt`.
  for (const raw of ["null", "[]", '"text"', "42"]) {
    res = await app.fetch(
      new Request("http://localhost/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw,
      }),
    );
    assert.equal(res.status, 400, `body ${raw} should be 400`);
  }

  // 2. Missing prompt
  res = await app.fetch(
    new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen-image-3.0-pro" }),
    }),
  );
  assert.equal(res.status, 400);
  let json = (await res.json()) as any;
  assert.ok(json.error.message.includes("prompt"));

  // 3. Invalid n (zero, fractional, or above the fan-out cap)
  for (const n of [0, 1.5, 11, 1000]) {
    res = await app.fetch(
      new Request("http://localhost/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen-image-3.0-pro",
          prompt: "cyberpunk cat",
          n,
        }),
      }),
    );
    assert.equal(res.status, 400, `n=${n} should be rejected`);
    json = (await res.json()) as any;
    assert.ok(json.error.message.includes("n"));
  }

  // 4. Invalid size
  res = await app.fetch(
    new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen-image-3.0-pro",
        prompt: "cyberpunk cat",
        size: "999x999",
      }),
    }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.ok(json.error.message.includes("size"));

  // 5. Invalid response_format
  res = await app.fetch(
    new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen-image-3.0-pro",
        prompt: "cyberpunk cat",
        response_format: "raw_buffer",
      }),
    }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.ok(json.error.message.includes("response_format"));

  // 6. Missing model
  res = await app.fetch(
    new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "cyberpunk cat",
      }),
    }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.ok(json.error.message.includes("model"));

  // 7. Model not supporting prompt-only image generation
  res = await app.fetch(
    new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "wan2.7-i2v",
        prompt: "cyberpunk cat",
      }),
    }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.ok(json.error.message.includes("requires a reference image"));
});

test("Videos Generations Route: validates video generation and task status requests", async () => {
  // 1. Invalid JSON body
  let res = await app.fetch(
    new Request("http://localhost/v1/videos/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "NOT_JSON",
    }),
  );
  assert.equal(res.status, 400);

  // 1b. Non-object bodies must be a 400, not a crash on `body.prompt`.
  for (const raw of ["null", "[]", '"text"', "42"]) {
    res = await app.fetch(
      new Request("http://localhost/v1/videos/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw,
      }),
    );
    assert.equal(res.status, 400, `body ${raw} should be 400`);
  }

  // 2. Missing prompt
  res = await app.fetch(
    new Request("http://localhost/v1/videos/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "wan3.0-video" }),
    }),
  );
  assert.equal(res.status, 400);
  let json = (await res.json()) as any;
  assert.ok(json.error.message.includes("prompt"));

  // 3. Invalid size
  res = await app.fetch(
    new Request("http://localhost/v1/videos/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "wan3.0-video",
        prompt: "cyberpunk drone flight",
        size: "invalid",
      }),
    }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.ok(json.error.message.includes("size"));

  // 4. Missing model
  res = await app.fetch(
    new Request("http://localhost/v1/videos/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "cyberpunk drone flight",
      }),
    }),
  );
  assert.equal(res.status, 400);

  // 5. Model not supporting video generation
  res = await app.fetch(
    new Request("http://localhost/v1/videos/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "wan2.7-i2v",
        prompt: "cyberpunk drone flight",
      }),
    }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.ok(json.error.message.includes("requires a reference image"));

  // 6. Video task status: non-existent task ID returns 404
  res = await app.fetch(new Request("http://localhost/v1/tasks/status/task_non_existent_123"));
  assert.equal(res.status, 404);
  json = (await res.json()) as any;
  assert.ok(json.error.message.includes("not found"));
});

test("Videos Task Status: a plain poll refreshes a pending task from upstream", async () => {
  resetVideoTasksForTests();
  createVideoTask({
    taskId: "task_poll_refresh",
    ownerId: "local-admin",
    accountId: "account-test",
    chatId: "chat-test",
    status: "pending",
  });

  const originalFetch = globalThis.fetch;
  const originalBrowserOnly = config.qwen.browserOnlyFetch;
  config.qwen.browserOnlyFetch = false;
  let statusRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      input instanceof Request ? input.url : String(input);
    if (url.includes("/api/v1/tasks/status/task_poll_refresh")) {
      statusRequests += 1;
      return new Response(
        JSON.stringify({
          task_status: "completed",
          video_url: "https://example.com/generated.mp4",
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/tasks/status/task_poll_refresh"),
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(statusRequests, 1);
    assert.equal(json.status, "completed");
    assert.equal(json.video_url, "https://example.com/generated.mp4");
    assert.equal(
      getVideoTask("task_poll_refresh", "local-admin")?.status,
      "completed",
    );
  } finally {
    globalThis.fetch = originalFetch;
    config.qwen.browserOnlyFetch = originalBrowserOnly;
    resetVideoTasksForTests();
  }
});

test("POST /v1/upload rejects a malformed multipart body with 400", async () => {
  const res = await app.fetch(
    new Request("http://localhost/v1/upload", {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=bogus" },
      body: "this is not a multipart body",
    }),
  );
  assert.equal(res.status, 400);
  const json = (await res.json()) as any;
  assert.equal(json.error.type, "invalid_request_error");
});
