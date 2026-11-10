import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.API_KEY = "";

import { app } from "../api/server.ts";
import { getDatabase } from "../core/database.ts";
import { createUser } from "../core/users.ts";
import { registerStream, removeStream } from "../core/stream-registry.ts";
import { setUserIdentity } from "../core/request-user.ts";
import {
  buildInternalSessionScopeHeaders,
  resolveSessionScopeId,
} from "../core/request-owner.ts";
import type { UserIdentity } from "../core/users.ts";

const db = getDatabase();

function withKey(key: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);
  return { ...init, headers };
}

function deleteUser(id: string): void {
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

function userIdentity(id: string): UserIdentity {
  return {
    id,
    label: id,
    role: "user",
    rateLimitRpm: 0,
    maxConcurrency: 0,
    legacy: false,
  };
}

test("stop: a tenant cannot abort another tenant's active stream", async () => {
  const owner = createUser("stop-owner", { role: "user" });
  const intruder = createUser("stop-intruder", { role: "user" });
  const controller = new AbortController();
  const completionId = "chatcmpl-tenant-isolation-stop";
  try {
    registerStream(completionId, {
      abortController: controller,
      accountId: "mock-account",
      uiSessionId: "shared-chat-id",
      targetResponseId: "shared-response-id",
      headers: {},
      ownerId: owner.user.id,
    });

    const denied = await app.fetch(
      new Request("http://localhost/v1/chat/completions/stop", {
        method: "POST",
        ...withKey(intruder.apiKey, {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: "shared-chat-id",
            response_id: "shared-response-id",
          }),
        }),
      }),
    );

    assert.equal(denied.status, 404);
    assert.equal(controller.signal.aborted, false);
  } finally {
    removeStream(completionId);
    deleteUser(owner.user.id);
    deleteUser(intruder.user.id);
  }
});

test("chat mode: only operators may mutate global state", async () => {
  const user = createUser("mode-user", { role: "user" });
  try {
    const response = await app.fetch(
      new Request("http://localhost/v1/chat/mode", {
        method: "POST",
        ...withKey(user.apiKey, {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "thread" }),
        }),
      }),
    );
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: { type: string } };
    assert.equal(body.error.type, "permission_error");
  } finally {
    deleteUser(user.user.id);
  }
});

test("operations: regular users cannot read logs, metrics, or token diagnostics", async () => {
  const user = createUser("ops-user", { role: "user" });
  try {
    for (const path of [
      "/logs",
      "/logs/live",
      "/metrics",
      "/diagnostics/tokens",
    ]) {
      const response = await app.fetch(
        new Request(`http://localhost${path}`, withKey(user.apiKey)),
      );
      assert.equal(response.status, 403, `${path} must require admin`);
    }
  } finally {
    deleteUser(user.user.id);
  }
});

test("health: regular users only see the public snapshot", async () => {
  const user = createUser("health-user", { role: "user" });
  try {
    const response = await app.fetch(
      new Request("http://localhost/health", withKey(user.apiKey)),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.version, undefined);
    assert.equal(body.metrics, undefined);
  } finally {
    deleteUser(user.user.id);
  }
});

test("request owner: adapter scope forwarding requires the internal token", async () => {
  const probe = new Hono<{ Variables: { forwarded: Record<string, string> } }>();
  probe.get("/forward", (c) => {
    setUserIdentity(c, userIdentity("tenant-a"));
    return c.json(buildInternalSessionScopeHeaders(c));
  });
  probe.get("/resolve", (c) => {
    // The inner loopback call authenticates as the operator.
    setUserIdentity(c, {
      ...userIdentity("global-admin"),
      role: "admin",
      legacy: true,
    });
    return c.json({ scope: resolveSessionScopeId(c) ?? null });
  });

  const forwarded = await probe.request("/forward");
  assert.equal(forwarded.status, 200);
  const headers = (await forwarded.json()) as Record<string, string>;
  assert.equal(headers["x-qwenproxy-session-scope"], "tenant-a");

  const trusted = await probe.request(
    new Request("http://localhost/resolve", { headers }),
  );
  assert.deepEqual(await trusted.json(), { scope: "tenant-a" });

  const spoofed = await probe.request(
    new Request("http://localhost/resolve", {
      headers: { "x-qwenproxy-session-scope": "tenant-a" },
    }),
  );
  assert.deepEqual(await spoofed.json(), { scope: null });
});
