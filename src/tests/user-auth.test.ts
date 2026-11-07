import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.API_KEY = "";

import { app } from "../api/server.ts";
import { getDatabase } from "../core/database.ts";
import { createUser, findUserByKey } from "../core/users.ts";
import { acquireUserStream } from "../core/user-quota.ts";

const db = getDatabase();
let snapshot: Array<Record<string, unknown>> = [];

beforeEach(() => {
  snapshot = db.prepare("SELECT * FROM users").all() as Array<
    Record<string, unknown>
  >;
  db.prepare("DELETE FROM users").run();
});

afterEach(() => {
  db.prepare("DELETE FROM users").run();
  const insert = db.prepare(`
    INSERT INTO users (
      id, label, api_key_hash, api_key_prefix, role,
      rate_limit_rpm, max_concurrency, created_at, updated_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of snapshot) {
    insert.run(
      row.id,
      row.label,
      row.api_key_hash,
      row.api_key_prefix,
      row.role,
      row.rate_limit_rpm,
      row.max_concurrency,
      row.created_at,
      row.updated_at,
      row.revoked_at,
    );
  }
});

function withKey(key: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);
  return { ...init, headers };
}

test("auth: loopback with no configured API_KEY remains open", async () => {
  const response = await app.request("/v1/chat/mode");
  assert.equal(response.status, 200);
});

test("auth: a configured API_KEY rejects invalid keys and accepts the legacy key", async () => {
  const previous = process.env.API_KEY;
  process.env.API_KEY = "sk-global-test-key";
  try {
    const invalid = await app.request(
      "/v1/chat/mode",
      withKey("sk-qpx-not-a-real-key"),
    );
    assert.equal(invalid.status, 401);

    const missing = await app.request("/v1/chat/mode");
    assert.equal(missing.status, 401);

    const legacy = await app.request(
      "/v1/chat/mode",
      withKey("sk-global-test-key"),
    );
    assert.equal(legacy.status, 200);
  } finally {
    if (previous === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previous;
  }
});

test("admin: local admin manages users and roles are enforced", async () => {
  const createdResponse = await app.request("/admin/api/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      label: "api-user",
      role: "user",
      rpm: 0,
      concurrency: 0,
    }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()) as {
    user: { id: string; label: string; role: string; prefix: string };
    api_key: string;
  };
  assert.equal(created.user.label, "api-user");
  assert.equal(created.user.role, "user");
  assert.match(created.api_key, /^sk-qpx-/);

  const listResponse = await app.request("/admin/api/users");
  assert.equal(listResponse.status, 200);
  const listed = (await listResponse.json()) as {
    users: Array<{ id: string; active_streams: number }>;
  };
  assert.ok(listed.users.some((user) => user.id === created.user.id));

  const forbidden = await app.request(
    "/admin/api/users",
    withKey(created.api_key),
  );
  assert.equal(forbidden.status, 403);

  const modeResponse = await app.request(
    "/v1/chat/mode",
    withKey(created.api_key),
  );
  assert.equal(modeResponse.status, 200);

  const rotateResponse = await app.request(
    `/admin/api/users/${created.user.id}/rotate`,
    { method: "POST" },
  );
  assert.equal(rotateResponse.status, 200);
  const rotated = (await rotateResponse.json()) as { api_key: string };
  assert.notEqual(rotated.api_key, created.api_key);

  const oldKey = await app.request(
    "/v1/chat/mode",
    withKey(created.api_key),
  );
  assert.equal(oldKey.status, 401);
  assert.equal(findUserByKey(created.api_key), null);

  const newKey = await app.request(
    "/v1/chat/mode",
    withKey(rotated.api_key),
  );
  assert.equal(newKey.status, 200);

  const revokeResponse = await app.request(
    `/admin/api/users/${created.user.id}`,
    { method: "DELETE" },
  );
  assert.equal(revokeResponse.status, 200);
  assert.deepEqual(await revokeResponse.json(), { success: true });

  const revoked = await app.request(
    "/v1/chat/mode",
    withKey(rotated.api_key),
  );
  assert.equal(revoked.status, 401);
});

test("admin: payload validation and unknown ids fail closed", async () => {
  const missingLabel = await app.request("/admin/api/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rpm: 1 }),
  });
  assert.equal(missingLabel.status, 400);

  const badRole = await app.request("/admin/api/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "role-test", role: "owner" }),
  });
  assert.equal(badRole.status, 400);

  const badLimit = await app.request("/admin/api/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "limit-test", rpm: -1 }),
  });
  assert.equal(badLimit.status, 400);

  const unknownRotate = await app.request(
    "/admin/api/users/does-not-exist/rotate",
    { method: "POST" },
  );
  assert.equal(unknownRotate.status, 404);

  const unknownDelete = await app.request(
    "/admin/api/users/does-not-exist",
    { method: "DELETE" },
  );
  assert.equal(unknownDelete.status, 404);
});

test("quota: RPM limit returns 429 with Retry-After before any chat work", async () => {
  const created = createUser("rpm-user", { rpm: 1, concurrency: 0 });

  const first = await app.request(
    "/v1/chat/mode",
    withKey(created.apiKey),
  );
  assert.equal(first.status, 200);

  const second = await app.request(
    "/v1/chat/mode",
    withKey(created.apiKey),
  );
  assert.equal(second.status, 429);
  assert.ok(second.headers.get("retry-after"));
  const body = (await second.json()) as {
    error: { type: string; message: string };
  };
  assert.equal(body.error.type, "rate_limit_error");
  assert.match(body.error.message, /requests per minute/i);
});

test("quota: concurrency denial returns 429 before parsing or upstream work", async () => {
  const created = createUser("concurrency-user", {
    rpm: 0,
    concurrency: 1,
  });

  const release = acquireUserStream({
    id: created.user.id,
    label: created.user.label,
    role: "user",
    rateLimitRpm: 0,
    maxConcurrency: 1,
    legacy: false,
  });
  assert.ok(release);

  const response = await app.request(
    "/v1/chat/completions",
    withKey(created.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.7-plus",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    }),
  );

  assert.equal(response.status, 429);
  const body = (await response.json()) as {
    error: { type: string; message: string };
  };
  assert.equal(body.error.type, "rate_limit_error");
  assert.match(body.error.message, /concurrency/i);

  release!();
});
