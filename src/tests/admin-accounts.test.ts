import test, { after } from "node:test";
import assert from "node:assert/strict";

process.env.API_KEY = "";

import { app } from "../api/server.ts";
import { loadAccounts, removeAccount } from "../core/accounts.ts";

const createdIds: string[] = [];
const unique = `admin-acct-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const email = `${unique}@example.com`;
const proxy = "http://proxy-user:proxy-pass@127.0.0.1:8080";

after(() => {
  for (const id of createdIds) {
    try {
      removeAccount(id);
    } catch {}
  }
});

function jsonRequest(body: unknown, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return { ...init, headers, body: JSON.stringify(body) };
}

test("accounts: add masks the email and proxy credentials", async () => {
  const response = await app.request(
    "/admin/api/accounts",
    jsonRequest({
      email,
      password: "super-secret-password",
      proxy,
    }, { method: "POST" }),
  );
  assert.equal(response.status, 201);

  const body = (await response.json()) as {
    account: {
      id: string;
      email: string;
      proxy: string | null;
      headers_ready: boolean;
      cooldown_remaining_ms: number;
    };
  };
  createdIds.push(body.account.id);

  assert.notEqual(body.account.email, email);
  assert.match(body.account.email, /^..\*\*\*@example\.com$/);
  assert.ok(!body.account.email.includes(unique));
  assert.ok(!(body.account.proxy || "").includes("proxy-pass"));
  assert.equal(body.account.cooldown_remaining_ms, 0);

  const list = await app.request("/admin/api/accounts");
  assert.equal(list.status, 200);
  const listed = (await list.json()) as {
    accounts: Array<{ id: string; email: string; proxy: string | null }>;
  };
  const entry = listed.accounts.find((item) => item.id === body.account.id);
  assert.ok(entry);
  assert.equal(entry.email, body.account.email);
  assert.ok(!(entry.proxy || "").includes("proxy-pass"));
});

test("accounts: duplicate and invalid payloads are rejected", async () => {
  const duplicate = await app.request(
    "/admin/api/accounts",
    jsonRequest({ email, password: "" }, { method: "POST" }),
  );
  assert.equal(duplicate.status, 400);

  const missing = await app.request(
    "/admin/api/accounts",
    jsonRequest({ password: "x" }, { method: "POST" }),
  );
  assert.equal(missing.status, 400);

  const badProxy = await app.request(
    "/admin/api/accounts",
    jsonRequest(
      { email: `${unique}-bad@example.com`, proxy: "not a url" },
      { method: "POST" },
    ),
  );
  assert.equal(badProxy.status, 400);
});

test("accounts: proxy edit, cooldown clear and delete", async () => {
  const id = createdIds[0];
  assert.ok(id);

  const patched = await app.request(
    `/admin/api/accounts/${encodeURIComponent(id)}/proxy`,
    jsonRequest({ proxy: null }, { method: "PATCH" }),
  );
  assert.equal(patched.status, 200);
  const patchedBody = (await patched.json()) as {
    account: { proxy: string | null };
  };
  assert.equal(patchedBody.account.proxy, null);

  const cooldown = await app.request(
    `/admin/api/accounts/${encodeURIComponent(id)}/cooldown/clear`,
    { method: "POST" },
  );
  assert.equal(cooldown.status, 200);

  const unknown = await app.request(
    "/admin/api/accounts/does-not-exist/cooldown/clear",
    { method: "POST" },
  );
  assert.equal(unknown.status, 404);

  const removed = await app.request(
    `/admin/api/accounts/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  assert.equal(removed.status, 200);
  assert.ok(!loadAccounts().some((account) => account.id === id));

  createdIds.length = 0;
});

test("accounts: mutations are audited without secrets", async () => {
  const audit = await app.request("/admin/api/audit?limit=100");
  assert.equal(audit.status, 200);
  const body = (await audit.json()) as {
    records: Array<{
      action: string;
      target: string;
      result: string;
      details: string | null;
    }>;
  };

  const create = body.records.find(
    (record) => record.action === "account.create" && record.result === "ok",
  );
  assert.ok(create);
  assert.ok(!JSON.stringify(create).includes("super-secret-password"));
  assert.ok(!JSON.stringify(create).includes("proxy-pass"));

  assert.ok(
    body.records.some(
      (record) =>
        record.action === "account.proxy.update" && record.result === "ok",
    ),
  );
  assert.ok(
    body.records.some(
      (record) => record.action === "account.delete" && record.result === "ok",
    ),
  );
});
