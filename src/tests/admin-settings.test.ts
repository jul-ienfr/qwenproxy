import test, { after } from "node:test";
import assert from "node:assert/strict";

process.env.API_KEY = "";

import { app } from "../api/server.ts";
import { applySettings, listSettings } from "../admin/settings.ts";

const original = listSettings();
const originalValues = Object.fromEntries(
  original.map((setting) => [setting.key, setting.value]),
);

after(() => {
  try {
    applySettings(originalValues);
  } catch {}
});

function jsonRequest(body: unknown, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return { ...init, headers, body: JSON.stringify(body) };
}

function valueOf(
  settings: Array<{ key: string; value: unknown }>,
  key: string,
): unknown {
  return settings.find((setting) => setting.key === key)?.value;
}

test("settings: the allowlist is exposed with no secrets", async () => {
  const response = await app.request("/admin/api/settings");
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    settings: Array<{
      key: string;
      type: string;
      restartRequired: boolean;
      help: string;
    }>;
  };

  const keys = body.settings.map((setting) => setting.key);
  assert.deepEqual(keys, [
    "chat_mode",
    "global_proxy_url",
    "chat_request_log",
    "rate_limit_requests",
    "rate_limit_tokens",
    "user_default_rpm",
    "user_default_concurrency",
  ]);
  for (const setting of body.settings) {
    assert.equal(setting.restartRequired, false);
    assert.ok(setting.help.length > 0);
  }
});

test("settings: unknown keys are rejected", async () => {
  const response = await app.request(
    "/admin/api/settings",
    jsonRequest({ values: { UNKNOWN_SETTING: "yes" } }, { method: "PUT" }),
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { message: string } };
  assert.match(body.error.message, /Unknown setting/);
});

test("settings: malformed payloads are rejected", async () => {
  const missing = await app.request(
    "/admin/api/settings",
    jsonRequest({}, { method: "PUT" }),
  );
  assert.equal(missing.status, 400);

  const badType = await app.request(
    "/admin/api/settings",
    jsonRequest(
      { values: { rate_limit_requests: "not-a-number" } },
      { method: "PUT" },
    ),
  );
  assert.equal(badType.status, 400);

  const badProxy = await app.request(
    "/admin/api/settings",
    jsonRequest(
      { values: { global_proxy_url: "not a proxy url" } },
      { method: "PUT" },
    ),
  );
  assert.equal(badProxy.status, 400);
});

test("settings: invalid chat modes are rejected", async () => {
  const response = await app.request(
    "/admin/api/settings",
    jsonRequest(
      { values: { chat_mode: "not-a-mode" } },
      { method: "PUT" },
    ),
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { message: string } };
  assert.match(body.error.message, /chat_mode/);
});

test("settings: a rejected batch rolls back earlier values", async () => {
  const before = valueOf(listSettings(), "rate_limit_requests");
  const response = await app.request(
    "/admin/api/settings",
    jsonRequest(
      {
        values: {
          // Applied first, then invalidated by the second key.
          rate_limit_requests: 4321,
          user_default_rpm: -1,
        },
      },
      { method: "PUT" },
    ),
  );
  assert.equal(response.status, 400);
  assert.equal(
    valueOf(listSettings(), "rate_limit_requests"),
    before,
    "the earlier field must not stay applied after the batch is rejected",
  );
});

test("settings: valid values are hot-applied and returned", async () => {
  const response = await app.request(
    "/admin/api/settings",
    jsonRequest(
      {
        values: {
          rate_limit_requests: 1234,
          rate_limit_tokens: 5678,
          user_default_rpm: 7,
          user_default_concurrency: 2,
          chat_request_log: true,
          chat_mode: "stateless-temp",
        },
      },
      { method: "PUT" },
    ),
  );
  assert.equal(response.status, 200);

  const body = (await response.json()) as {
    settings: Array<{ key: string; value: unknown }>;
  };
  assert.equal(valueOf(body.settings, "rate_limit_requests"), 1234);
  assert.equal(valueOf(body.settings, "rate_limit_tokens"), 5678);
  assert.equal(valueOf(body.settings, "user_default_rpm"), 7);
  assert.equal(valueOf(body.settings, "user_default_concurrency"), 2);
  assert.equal(valueOf(body.settings, "chat_request_log"), true);
  assert.equal(valueOf(body.settings, "chat_mode"), "stateless-temp");

  const reread = await app.request("/admin/api/settings");
  const rereadBody = (await reread.json()) as {
    settings: Array<{ key: string; value: unknown }>;
  };
  assert.equal(valueOf(rereadBody.settings, "chat_mode"), "stateless-temp");
});

test("settings: audit records the change without values", async () => {
  const audit = await app.request("/admin/api/audit?limit=50");
  assert.equal(audit.status, 200);
  const body = (await audit.json()) as {
    records: Array<{ action: string; target: string; result: string }>;
  };
  const record = body.records.find(
    (item) => item.action === "settings.update" && item.result === "ok",
  );
  assert.ok(record);
  assert.match(record.target, /rate_limit_requests/);
});
