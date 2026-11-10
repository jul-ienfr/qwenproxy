import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { app } from "../api/server.ts";
import { loadAccounts } from "../core/accounts.ts";
import { getDatabase } from "../core/database.ts";
import {
  buildSpecializedFeatureConfig,
  extractArtifacts,
  isSafeArtifactUrl,
  isSpecializedCapabilityFailure,
  listSpecializedModels,
  resolveResearchMode,
  resolveSpecializedModel,
  specializedCapabilityError,
} from "../core/specialized-modes.ts";
import {
  awaitSpecializedTask,
  cancelSpecializedTask,
  checkSpecializedTaskCapacity,
  countActiveSpecializedTasks,
  createSpecializedTask,
  getSpecializedTask,
  launchSpecializedTask,
  listSpecializedTasks,
  pruneSpecializedTasks,
  recoverInterruptedSpecializedTasks,
  setSpecializedTaskRunnerForTests,
  setSpecializedTaskTimeoutForTests,
} from "../core/specialized-tasks.ts";
import { isAnswerPhase, isThinkingPhase } from "../routes/chat/helpers.ts";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

test("specialized catalog exposes four canonical virtual models", () => {
  const models = listSpecializedModels();
  assert.deepEqual(
    models.map((model) => model.id).sort(),
    [
      "qwen-deep-research",
      "qwen-full-stack",
      "qwen-slides",
      "qwen-web-dev",
    ],
  );

  const research = resolveSpecializedModel("qwen-deep-research");
  assert.equal(research?.chatType, "deep_research");
  assert.equal(research?.kind, "research");

  const slides = resolveSpecializedModel("QWEN-SLIDES");
  assert.equal(slides?.chatType, "slides");
  assert.equal(slides?.kind, "slides");

  // Full-stack shares the upstream web_dev engine with Web Dev.
  assert.equal(resolveSpecializedModel("qwen-full-stack")?.chatType, "web_dev");
  assert.ok(resolveSpecializedModel("qwen-full-stack")?.promptPrefix);

  // Convenience spellings resolve but are not advertised.
  assert.equal(resolveSpecializedModel("deep-research")?.id, "qwen-deep-research");
  assert.equal(resolveSpecializedModel("slides")?.id, "qwen-slides");
  assert.equal(resolveSpecializedModel("qwen3.8-max"), undefined);
  assert.equal(resolveSpecializedModel(undefined), undefined);

  // Returned definitions are copies: callers cannot mutate the catalog.
  const copy = resolveSpecializedModel("qwen-web-dev")!;
  copy.chatType = "t2t";
  assert.equal(resolveSpecializedModel("qwen-web-dev")?.chatType, "web_dev");
});

test("research mode accepts explicit values and falls back to reasoning mode", () => {
  assert.equal(resolveResearchMode("advance"), "advance");
  assert.equal(resolveResearchMode("ADVANCED"), "advance");
  assert.equal(resolveResearchMode("deep"), "advance");
  assert.equal(resolveResearchMode("high"), "advance");

  assert.equal(resolveResearchMode("normal"), "normal");
  assert.equal(resolveResearchMode("low"), "normal");
  assert.equal(resolveResearchMode("something-else"), "normal");
  assert.equal(resolveResearchMode(undefined), "normal");

  assert.equal(resolveResearchMode(undefined, "thinking"), "advance");
  assert.equal(resolveResearchMode(undefined, "auto"), "normal");
  assert.equal(resolveResearchMode(undefined, "fast"), "normal");

  // An explicit body value wins over the thinking suffix.
  assert.equal(resolveResearchMode("normal", "thinking"), "normal");
  assert.equal(resolveResearchMode("advance", "fast"), "advance");
});

test("feature config maps reasoning and research settings without chat search", () => {
  const research = resolveSpecializedModel("qwen-deep-research")!;
  const advanced = buildSpecializedFeatureConfig(research, "thinking", "advance");
  assert.equal(advanced.thinking_enabled, true);
  assert.equal(advanced.thinking_mode, "Thinking");
  assert.equal(advanced.thinking_format, "summary");
  assert.equal(advanced.research_mode, "advance");
  assert.equal(advanced.auto_thinking, false);
  assert.equal(advanced.auto_search, false);

  const normal = buildSpecializedFeatureConfig(research, "auto", "normal");
  assert.equal(normal.thinking_enabled, true);
  assert.equal(normal.thinking_mode, "Auto");
  assert.equal(normal.auto_thinking, true);
  assert.equal(normal.research_mode, "normal");

  const slides = resolveSpecializedModel("qwen-slides")!;
  const fast = buildSpecializedFeatureConfig(slides, "fast", "advance");
  assert.equal(fast.thinking_enabled, false);
  assert.equal(fast.thinking_mode, "Fast");
  assert.equal("thinking_format" in fast, false);
  // Only research models carry an advance research mode.
  assert.equal(fast.research_mode, "normal");
  assert.equal(fast.auto_search, false);
});

test("safe artifact URLs accept only absolute http(s) without credentials", () => {
  assert.equal(isSafeArtifactUrl("https://cdn.example.com/report.pdf"), true);
  assert.equal(isSafeArtifactUrl("http://cdn.example.com/a.png"), true);

  assert.equal(isSafeArtifactUrl("javascript:alert(1)"), false);
  assert.equal(isSafeArtifactUrl("data:text/html,<script>"), false);
  assert.equal(isSafeArtifactUrl("ftp://example.com/file.pdf"), false);
  assert.equal(isSafeArtifactUrl("/relative/path"), false);
  assert.equal(isSafeArtifactUrl("https://user:pass@example.com/x"), false);
  assert.equal(isSafeArtifactUrl("https://"), false);
  assert.equal(isSafeArtifactUrl("http://127.0.0.1/report.pdf"), false);
  assert.equal(isSafeArtifactUrl("http://[::1]/report.pdf"), false);
  assert.equal(isSafeArtifactUrl("http://localhost/report.pdf"), false);
  assert.equal(isSafeArtifactUrl("https://"), false);
  assert.equal(isSafeArtifactUrl(""), false);
  assert.equal(isSafeArtifactUrl(null), false);
  assert.equal(isSafeArtifactUrl(`https://example.com/${"a".repeat(5000)}`), false);
});

test("artifact extraction classifies and deduplicates report links", () => {
  const content = [
    "# Quarterly report",
    "Read the [final report](https://cdn.example.com/report/q4).",
    "![chart](https://cdn.example.com/chart.png)",
    "[source](https://news.example.com/article)",
    "[download](https://cdn.example.com/output.zip)",
    "[pdf](https://cdn.example.com/paper.pdf)",
    "[bad](javascript:alert(1))",
    "[creds](https://user:pass@example.com/private)",
    "Bare citation https://news.example.com/article.",
  ].join("\n");

  const artifacts = extractArtifacts(content);
  const byUrl = new Map(artifacts.map((artifact) => [artifact.url, artifact]));

  assert.equal(byUrl.get("https://cdn.example.com/report/q4")?.type, "report");
  assert.equal(
    byUrl.get("https://cdn.example.com/report/q4")?.title,
    "final report",
  );
  assert.equal(byUrl.get("https://cdn.example.com/chart.png")?.type, "image");
  assert.equal(byUrl.get("https://cdn.example.com/output.zip")?.type, "code");
  assert.equal(byUrl.get("https://cdn.example.com/paper.pdf")?.type, "pdf");
  assert.equal(byUrl.get("https://news.example.com/article")?.type, "link");

  // Duplicate citation was only added once.
  assert.equal(
    artifacts.filter(
      (artifact) => artifact.url === "https://news.example.com/article",
    ).length,
    1,
  );
  assert.equal(
    artifacts.some((artifact) => artifact.url.startsWith("javascript:")),
    false,
  );
  assert.equal(
    artifacts.some((artifact) => artifact.url.includes("user:pass")),
    false,
  );
  assert.deepEqual(extractArtifacts(undefined), []);
  assert.deepEqual(extractArtifacts("no links here"), []);
});

test("specialized phases surface plans as reasoning and slides as answers", () => {
  assert.equal(isThinkingPhase("ResearchPlanning"), true);
  assert.equal(isThinkingPhase("DeepThinking"), true);
  assert.equal(isAnswerPhase("slides"), true);
  assert.equal(isAnswerPhase("deep_research_answer"), true);
  assert.equal(isAnswerPhase("PdfMdGen"), true);
  assert.equal(isAnswerPhase("ResearchPlanning"), false);
});

test("capability helper produces a stable OpenAI-compatible 400", () => {
  const unavailable = specializedCapabilityError(
    "requires an account",
    "capability_unavailable",
  );
  assert.equal(unavailable.statusCode, 400);
  assert.equal(unavailable.code, "capability_unavailable");
  assert.equal(unavailable.toOpenAI().error.type, "invalid_request_error");

  const unsupported = specializedCapabilityError("upstream rejected the mode");
  assert.equal(unsupported.code, "capability_unsupported");

  assert.equal(
    isSpecializedCapabilityFailure(new Error("Model not supported")),
    true,
  );
  assert.equal(
    isSpecializedCapabilityFailure(new Error("chat_type invalid")),
    true,
  );
  assert.equal(
    isSpecializedCapabilityFailure(new Error("Permission denied")),
    true,
  );
  assert.equal(
    isSpecializedCapabilityFailure(new Error("socket hang up")),
    false,
  );
});

test("task store tracks queued, running, succeeded and failed states", async () => {
  const owner = unique("owner");
  const task = createSpecializedTask({
    ownerId: owner,
    model: "qwen-deep-research",
    mode: "research",
  });
  assert.equal(task.status, "queued");
  assert.equal(task.progress, 0);
  assert.equal(getSpecializedTask(task.id, "someone-else"), undefined);
  assert.ok(listSpecializedTasks(owner).some((row) => row.id === task.id));

  let seen: { body: Record<string, unknown>; authorization?: string; origin: string } | undefined;
  setSpecializedTaskRunnerForTests(async (input) => {
    seen = {
      body: input.body,
      authorization: input.authorization,
      origin: input.origin,
    };
    const content =
      "Report ready: [PDF](https://cdn.example.com/report/q4.pdf)";
    return {
      content,
      artifacts: extractArtifacts(content),
      usage: { total_tokens: 42 },
    };
  });

  try {
    launchSpecializedTask({
      task,
      body: { model: "qwen-deep-research", messages: [] },
      authorization: "Bearer caller-key",
      origin: "http://127.0.0.1:9",
    });
    await awaitSpecializedTask(task.id);

    assert.equal(seen?.body.model, "qwen-deep-research");
    assert.equal(seen?.authorization, "Bearer caller-key");
    assert.equal(seen?.origin, "http://127.0.0.1:9");

    const stored = getSpecializedTask(task.id, owner);
    assert.equal(stored?.status, "succeeded");
    assert.equal(stored?.progress, 100);
    assert.equal(stored?.error, null);
    assert.equal(stored?.result?.content.includes("Report ready"), true);
    assert.deepEqual(
      stored?.result?.artifacts.map((artifact) => artifact.type),
      ["pdf"],
    );
    assert.deepEqual(stored?.result?.citations, [
      { url: "https://cdn.example.com/report/q4.pdf", title: "PDF" },
    ]);
    assert.deepEqual(stored?.result?.usage, { total_tokens: 42 });
  } finally {
    setSpecializedTaskRunnerForTests(undefined);
  }

  const failed = createSpecializedTask({
    ownerId: owner,
    model: "qwen-slides",
    mode: "slides",
  });
  setSpecializedTaskRunnerForTests(async () => {
    throw Object.assign(new Error("Model not supported"), {
      code: "capability_unsupported",
    });
  });
  try {
    launchSpecializedTask({
      task: failed,
      body: { model: "qwen-slides", messages: [] },
      origin: "http://127.0.0.1:9",
    });
    await awaitSpecializedTask(failed.id);

    const stored = getSpecializedTask(failed.id, owner);
    assert.equal(stored?.status, "failed");
    assert.equal(stored?.error?.code, "capability_unsupported");
    assert.match(stored?.error?.message ?? "", /not supported/);
  } finally {
    setSpecializedTaskRunnerForTests(undefined);
  }
});

test("cancelling a running task aborts the runner and keeps the state", async () => {
  const owner = unique("owner");
  const task = createSpecializedTask({
    ownerId: owner,
    model: "qwen-slides",
    mode: "slides",
  });

  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  setSpecializedTaskRunnerForTests(async ({ signal }) => {
    markStarted();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () =>
        reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return { content: "", artifacts: [] };
  });

  try {
    launchSpecializedTask({
      task,
      body: { model: "qwen-slides", messages: [] },
      origin: "http://127.0.0.1:9",
    });
    await started;

    const cancelled = cancelSpecializedTask(task.id, owner);
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.error?.code, "task_cancelled");

    await awaitSpecializedTask(task.id);
    const stored = getSpecializedTask(task.id, owner);
    assert.equal(stored?.status, "cancelled");
    assert.equal(stored?.error?.code, "task_cancelled");
  } finally {
    setSpecializedTaskRunnerForTests(undefined);
  }
});

test("ownership isolation hides another user's task", () => {
  const owner = unique("owner");
  const task = createSpecializedTask({
    ownerId: owner,
    model: "qwen-web-dev",
    mode: "artifact",
  });

  assert.equal(cancelSpecializedTask(task.id, "other-owner"), undefined);
  assert.equal(getSpecializedTask(task.id, "other-owner"), undefined);
  assert.ok(getSpecializedTask(task.id, owner));

  const rows = listSpecializedTasks("other-owner");
  assert.equal(rows.some((row) => row.id === task.id), false);
});

test("restart recovery marks interrupted tasks failed and pruning drops old rows", () => {
  const owner = unique("owner");
  const queued = createSpecializedTask({
    ownerId: owner,
    model: "qwen-deep-research",
    mode: "research",
  });
  const running = createSpecializedTask({
    ownerId: owner,
    model: "qwen-deep-research",
    mode: "research",
  });
  getDatabase()
    .prepare("UPDATE specialized_tasks SET status = 'running' WHERE id = ?")
    .run(running.id);

  const recovered = recoverInterruptedSpecializedTasks();
  assert.ok(recovered >= 2);

  for (const task of [queued, running]) {
    const stored = getSpecializedTask(task.id, owner);
    assert.equal(stored?.status, "failed");
    assert.equal(stored?.error?.code, "interrupted");
    assert.equal(stored?.progress, 100);
  }

  const expired = createSpecializedTask({
    ownerId: owner,
    model: "qwen-slides",
    mode: "slides",
  });
  getDatabase()
    .prepare("UPDATE specialized_tasks SET updated_at = ? WHERE id = ?")
    .run(Date.now() - 60_000, expired.id);

  const pruned = pruneSpecializedTasks(1_000);
  assert.ok(pruned >= 1);
  assert.equal(getSpecializedTask(expired.id, owner), undefined);
});

test("POST /v1/tasks rejects non-specialized models with a capability error", async () => {
  const response = await app.fetch(
    new Request("http://localhost/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.8-max",
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as any;
  assert.equal(body.error.code, "capability_unavailable");
  assert.match(body.error.message, /not a specialized async mode/);
});

test("POST /v1/tasks runs asynchronously and exposes the result", async () => {
  let receivedAuthorization: string | undefined;
  setSpecializedTaskRunnerForTests(async ({ body, authorization }) => {
    receivedAuthorization = authorization;
    const content = [
      "Slide deck ready.",
      "[preview](https://cdn.example.com/slides/deck.pdf)",
    ].join("\n");
    return {
      content,
      artifacts: extractArtifacts(content),
      usage: { total_tokens: 7 },
    };
  });

  try {
    const createResponse = await app.fetch(
      new Request("http://localhost/v1/tasks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-route-key",
        },
        body: JSON.stringify({
          model: "qwen-slides",
          messages: [{ role: "user", content: "Build a deck" }],
        }),
      }),
    );
    assert.equal(createResponse.status, 202);
    const created = (await createResponse.json()) as any;
    assert.match(created.id, /^task_/);
    assert.equal(created.object, "specialized.task");
    assert.equal(created.model, "qwen-slides");
    assert.equal(created.mode, "slides");
    assert.equal(receivedAuthorization, "Bearer test-route-key");

    await awaitSpecializedTask(created.id);

    const statusResponse = await app.fetch(
      new Request(`http://localhost/v1/tasks/${created.id}`),
    );
    assert.equal(statusResponse.status, 200);
    const task = (await statusResponse.json()) as any;
    assert.equal(task.status, "succeeded");
    assert.equal(task.progress, 100);
    assert.equal(task.result.content.includes("Slide deck ready"), true);
    assert.equal(task.result.artifacts[0].type, "pdf");
    assert.deepEqual(task.result.citations, [
      { url: "https://cdn.example.com/slides/deck.pdf", title: "preview" },
    ]);
    assert.equal(task.result.usage.total_tokens, 7);

    const listResponse = await app.fetch(
      new Request("http://localhost/v1/tasks?limit=10"),
    );
    assert.equal(listResponse.status, 200);
    const list = (await listResponse.json()) as any;
    assert.equal(list.object, "list");
    assert.ok(list.data.some((row: any) => row.id === created.id));
  } finally {
    setSpecializedTaskRunnerForTests(undefined);
  }

  const missing = await app.fetch(
    new Request("http://localhost/v1/tasks/task_does-not-exist"),
  );
  assert.equal(missing.status, 404);
});

test("specialized models are advertised in /v1/models", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/models")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "qwen3.8-max",
              owned_by: "qwen",
              info: { is_active: true, meta: { modality: ["text"] } },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;

  try {
    const response = await app.fetch(
      new Request("http://localhost/v1/models"),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    const ids = body.data.map((model: any) => model.id);

    for (const id of [
      "qwen-deep-research",
      "qwen-web-dev",
      "qwen-full-stack",
      "qwen-slides",
    ]) {
      assert.ok(ids.includes(id), `${id} must be advertised`);
    }

    const research = body.data.find(
      (model: any) => model.id === "qwen-deep-research",
    );
    assert.equal(research.specialized_mode, "research");
    assert.equal(research.supports_async, true);
    assert.equal(research.supports_citations, true);
    assert.equal(research.supports_artifacts, true);
    assert.equal(research.is_active, true);

    const slides = body.data.find((model: any) => model.id === "qwen-slides");
    assert.equal(slides.specialized_mode, "slides");
    assert.equal(slides.supports_citations, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat completions reports capability_unavailable when no account exists", async (t) => {
  if (loadAccounts().length > 0) {
    t.skip("test database already contains configured accounts");
    return;
  }

  const response = await app.fetch(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "qwen-deep-research",
        stream: false,
        messages: [{ role: "user", content: "What changed in 2026?" }],
      }),
    }),
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as any;
  assert.equal(body.error.code, "capability_unavailable");
  assert.match(body.error.message, /requires at least one configured Qwen account/);
});

test("task capacity enforces per-owner and global active limits", () => {
  const owner = unique("owner");
  const first = createSpecializedTask({
    ownerId: owner,
    model: "qwen-deep-research",
    mode: "research",
  });
  const second = createSpecializedTask({
    ownerId: owner,
    model: "qwen-deep-research",
    mode: "research",
  });

  assert.equal(countActiveSpecializedTasks(owner), 2);

  assert.deepEqual(
    checkSpecializedTaskCapacity(owner, {
      maxActivePerUser: 2,
      maxActive: 0,
    }),
    { allowed: false, reason: "per_user", limit: 2, active: 2 },
  );

  // The global count includes the two tasks above plus anything left by other
  // suites, so derive the boundary instead of assuming an empty store.
  const globalBase = countActiveSpecializedTasks();
  const global = checkSpecializedTaskCapacity(owner, {
    maxActivePerUser: 3,
    maxActive: globalBase,
  });
  assert.equal(global.allowed, false);
  assert.equal(global.reason, "global");
  assert.equal(global.limit, globalBase);

  assert.equal(
    checkSpecializedTaskCapacity(owner, {
      maxActivePerUser: 3,
      maxActive: globalBase + 1,
    }).allowed,
    true,
  );

  // 0 means unlimited for both caps.
  assert.equal(
    checkSpecializedTaskCapacity(owner, {
      maxActivePerUser: 0,
      maxActive: 0,
    }).allowed,
    true,
  );

  cancelSpecializedTask(first.id, owner);
  assert.equal(countActiveSpecializedTasks(owner), 1);
  assert.equal(
    checkSpecializedTaskCapacity(owner, {
      maxActivePerUser: 2,
      maxActive: 0,
    }).allowed,
    true,
  );

  cancelSpecializedTask(second.id, owner);
});

test("POST /v1/tasks returns 429 once the per-user active cap is reached", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  setSpecializedTaskRunnerForTests(async ({ signal }) => {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () =>
        reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      gate.then(() => resolve());
    });
    return { content: "done", artifacts: [] };
  });

  const create = () =>
    app.fetch(
      new Request("http://localhost/v1/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "qwen-slides",
          messages: [{ role: "user", content: "Build a deck" }],
        }),
      }),
    );

  try {
    const created: string[] = [];
    // The default per-user cap is 4.
    for (let i = 0; i < 4; i++) {
      const response = await create();
      assert.equal(response.status, 202);
      created.push(((await response.json()) as any).id);
    }

    const blocked = await create();
    assert.equal(blocked.status, 429);
    const body = (await blocked.json()) as any;
    assert.equal(body.error.code, "task_limit_exceeded");
    assert.equal(body.error.type, "rate_limit_error");
    assert.match(body.error.message, /limit 4/);

    const cancelled = await app.fetch(
      new Request(`http://localhost/v1/tasks/${created[0]}`, {
        method: "DELETE",
      }),
    );
    assert.equal(cancelled.status, 200);

    const allowed = await create();
    assert.equal(allowed.status, 202);
    created.push(((await allowed.json()) as any).id);

    release();
    await Promise.all(created.map((id) => awaitSpecializedTask(id)));
  } finally {
    release();
    setSpecializedTaskRunnerForTests(undefined);
  }
});

test("a timed-out task fails with task_timeout instead of cancelled", async () => {
  const owner = unique("owner");
  const task = createSpecializedTask({
    ownerId: owner,
    model: "qwen-deep-research",
    mode: "research",
  });

  setSpecializedTaskTimeoutForTests(25);
  setSpecializedTaskRunnerForTests(async ({ signal }) => {
    await new Promise<void>((_resolve, reject) => {
      const onAbort = () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return { content: "", artifacts: [] };
  });

  try {
    launchSpecializedTask({
      task,
      body: { model: "qwen-deep-research", messages: [] },
      origin: "http://127.0.0.1:9",
    });
    await awaitSpecializedTask(task.id);

    const stored = getSpecializedTask(task.id, owner);
    assert.equal(stored?.status, "failed");
    assert.equal(stored?.error?.code, "task_timeout");
    assert.match(stored?.error?.message ?? "", /deadline/);
  } finally {
    setSpecializedTaskTimeoutForTests(undefined);
    setSpecializedTaskRunnerForTests(undefined);
  }
});
