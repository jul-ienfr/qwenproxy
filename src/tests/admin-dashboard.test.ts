import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.API_KEY = "sk-dash-admin-test-key";

import { app } from "../api/server.ts";
import { getDatabase } from "../core/database.ts";
import { createUser, revokeUser, rotateUserKey } from "../core/users.ts";
import {
  LOGIN_MAX_FAILURES,
  resetLoginThrottleForTests,
} from "../admin/login-throttle.ts";

const ADMIN_KEY = "sk-dash-admin-test-key";
const db = getDatabase();
let snapshot: Array<Record<string, unknown>> = [];

beforeEach(() => {
  resetLoginThrottleForTests();
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

function bearer(key: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);
  return { ...init, headers };
}

function jsonRequest(body: unknown, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return { ...init, headers, body: JSON.stringify(body) };
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie") || "";
  const match = /qpx_admin=([^;]+)/.exec(setCookie);
  assert.ok(match, `expected a qpx_admin Set-Cookie, got: ${setCookie}`);
  return `qpx_admin=${match[1]}`;
}

test("dashboard: static UI is served without authentication", async () => {
  const page = await app.request("/admin");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") || "", /text\/html/);
  assert.match(
    page.headers.get("content-security-policy") || "",
    /default-src 'none'/,
  );
  assert.match(page.headers.get("x-frame-options") || "", /DENY/);
  assert.match(await page.text(), /QwenProxy Admin/);

  const script = await app.request("/admin/assets/admin.js");
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type") || "", /javascript/);
});

test("dashboard: unauthenticated API calls fail closed", async () => {
  const overview = await app.request("/admin/api/overview");
  assert.equal(overview.status, 401);

  const session = await app.request("/admin/api/session");
  assert.equal(session.status, 401);
});

test("dashboard: login rejects a wrong key and accepts the admin key", async () => {
  const wrong = await app.request(
    "/admin/api/session",
    jsonRequest({ apiKey: "sk-not-the-key" }, { method: "POST" }),
  );
  assert.equal(wrong.status, 401);

  const ok = await app.request(
    "/admin/api/session",
    jsonRequest({ apiKey: ADMIN_KEY }, { method: "POST" }),
  );
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as {
    user: { id: string; role: string };
    csrf: string;
    expiresAt: number;
  };
  assert.equal(body.user.role, "admin");
  assert.ok(body.csrf.length >= 16);
  assert.ok(body.expiresAt > Date.now());

  const cookie = sessionCookie(ok);

  const current = await app.request("/admin/api/session", {
    headers: { cookie },
  });
  assert.equal(current.status, 200);
  const currentBody = (await current.json()) as { user: { role: string } };
  assert.equal(currentBody.user.role, "admin");

  const overview = await app.request("/admin/api/overview", {
    headers: { cookie },
  });
  assert.equal(overview.status, 200);
  const snapshot = (await overview.json()) as {
    accounts: { list: unknown[] };
    requests: { rpm: number };
    memory: { rssMb: number };
    usage: { totalTokens: number };
  };
  assert.ok(Array.isArray(snapshot.accounts.list));
  assert.equal(typeof snapshot.requests.rpm, "number");
  assert.equal(typeof snapshot.memory.rssMb, "number");
  assert.equal(typeof snapshot.usage.totalTokens, "number");
});

test("dashboard: repeated failed logins are throttled", async () => {
  for (let attempt = 0; attempt < LOGIN_MAX_FAILURES; attempt++) {
    const wrong = await app.request(
      "/admin/api/session",
      jsonRequest({ apiKey: "sk-dash-brute-force" }, { method: "POST" }),
    );
    assert.equal(wrong.status, 401);
  }

  // Once the cap is reached the source is locked out, including for a valid
  // credential: otherwise reaching the cap would still confirm the key.
  const locked = await app.request(
    "/admin/api/session",
    jsonRequest({ apiKey: ADMIN_KEY }, { method: "POST" }),
  );
  assert.equal(locked.status, 429);
  const retryAfter = Number(locked.headers.get("retry-after"));
  assert.ok(Number.isFinite(retryAfter) && retryAfter > 0);
  const body = (await locked.json()) as {
    error: { type: string; message: string };
  };
  assert.equal(body.error.type, "invalid_request_error");
  assert.match(body.error.message, /too many failed login attempts/i);
});

test("dashboard: bearer clients bypass cookies and CSRF", async () => {
  const overview = await app.request("/admin/api/overview", bearer(ADMIN_KEY));
  assert.equal(overview.status, 200);

  const settings = await app.request(
    "/admin/api/settings",
    bearer(ADMIN_KEY),
  );
  assert.equal(settings.status, 200);
});

test("dashboard: cookie mutations require the CSRF token", async () => {
  const login = await app.request(
    "/admin/api/session",
    jsonRequest({ apiKey: ADMIN_KEY }, { method: "POST" }),
  );
  const cookie = sessionCookie(login);
  const { csrf } = (await login.json()) as { csrf: string };

  const withoutToken = await app.request(
    "/admin/api/settings",
    jsonRequest({ values: { rate_limit_requests: 4321 } }, {
      method: "PUT",
      headers: { cookie },
    }),
  );
  assert.equal(withoutToken.status, 403);

  const withToken = await app.request(
    "/admin/api/settings",
    jsonRequest({ values: { rate_limit_requests: 4321 } }, {
      method: "PUT",
      headers: { cookie, "x-csrf-token": csrf },
    }),
  );
  assert.equal(withToken.status, 200);
  const body = (await withToken.json()) as {
    settings: Array<{ key: string; value: number }>;
  };
  const entry = body.settings.find((item) => item.key === "rate_limit_requests");
  assert.equal(entry?.value, 4321);
});

test("dashboard: a non-admin user key is refused everywhere", async () => {
  const created = createUser("dash-plain-user", { role: "user" });

  const login = await app.request(
    "/admin/api/session",
    jsonRequest({ apiKey: created.apiKey }, { method: "POST" }),
  );
  assert.equal(login.status, 403);

  const overview = await app.request(
    "/admin/api/overview",
    bearer(created.apiKey),
  );
  assert.equal(overview.status, 403);
});

test("dashboard: revoking an admin invalidates existing session cookies", async () => {
  const created = createUser("dash-revocable-admin", { role: "admin" });
  const login = await app.request(
    "/admin/api/session",
    jsonRequest({ apiKey: created.apiKey }, { method: "POST" }),
  );
  assert.equal(login.status, 200);
  const cookie = sessionCookie(login);

  const before = await app.request("/admin/api/overview", {
    headers: { cookie },
  });
  assert.equal(before.status, 200);

  assert.equal(revokeUser(created.user.id), true);

  const overview = await app.request("/admin/api/overview", {
    headers: { cookie },
  });
  assert.equal(overview.status, 401);

  const current = await app.request("/admin/api/session", {
    headers: { cookie },
  });
  assert.equal(current.status, 401);
  assert.match(current.headers.get("set-cookie") || "", /Max-Age=0/);
});

test("dashboard: rotating an admin key invalidates existing session cookies", async () => {
  const created = createUser("dash-rotatable-admin", { role: "admin" });
  const login = await app.request(
    "/admin/api/session",
    jsonRequest({ apiKey: created.apiKey }, { method: "POST" }),
  );
  assert.equal(login.status, 200);
  const cookie = sessionCookie(login);

  const rotated = rotateUserKey(created.user.id);

  const stale = await app.request("/admin/api/overview", {
    headers: { cookie },
  });
  assert.equal(stale.status, 401);

  const relogin = await app.request(
    "/admin/api/session",
    jsonRequest({ apiKey: rotated.apiKey }, { method: "POST" }),
  );
  assert.equal(relogin.status, 200);
  const freshCookie = sessionCookie(relogin);
  const overview = await app.request("/admin/api/overview", {
    headers: { cookie: freshCookie },
  });
  assert.equal(overview.status, 200);
});

test("dashboard: changing the global API_KEY invalidates legacy sessions", async () => {
  const login = await app.request(
    "/admin/api/session",
    jsonRequest({ apiKey: ADMIN_KEY }, { method: "POST" }),
  );
  assert.equal(login.status, 200);
  const cookie = sessionCookie(login);

  const previous = process.env.API_KEY;
  process.env.API_KEY = "sk-dash-rotated-global-key";
  try {
    const stale = await app.request("/admin/api/overview", {
      headers: { cookie },
    });
    assert.equal(stale.status, 401);

    const relogin = await app.request(
      "/admin/api/session",
      jsonRequest({ apiKey: "sk-dash-rotated-global-key" }, { method: "POST" }),
    );
    assert.equal(relogin.status, 200);
  } finally {
    if (previous === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previous;
  }
});

test("dashboard: origin checks tolerate a TLS proxy but reject another host", async () => {
  const login = await app.request(
    "/admin/api/session",
    jsonRequest({ apiKey: ADMIN_KEY }, { method: "POST" }),
  );
  const cookie = sessionCookie(login);
  const { csrf } = (await login.json()) as { csrf: string };

  const settings = { values: { rate_limit_requests: 1234 } };
  const proxied = await app.request(
    "/admin/api/settings",
    jsonRequest(settings, {
      method: "PUT",
      headers: {
        cookie,
        "x-csrf-token": csrf,
        origin: "https://localhost",
      },
    }),
  );
  assert.equal(proxied.status, 200);

  const foreign = await app.request(
    "/admin/api/settings",
    jsonRequest(settings, {
      method: "PUT",
      headers: {
        cookie,
        "x-csrf-token": csrf,
        origin: "https://evil.example",
      },
    }),
  );
  assert.equal(foreign.status, 403);

  const opaque = await app.request(
    "/admin/api/settings",
    jsonRequest(settings, {
      method: "PUT",
      headers: {
        cookie,
        "x-csrf-token": csrf,
        origin: "null",
      },
    }),
  );
  assert.equal(opaque.status, 403);
});

test("dashboard: legacy no-key mutations still reject a cross-origin browser", async () => {
  const previous = process.env.API_KEY;
  delete process.env.API_KEY;
  try {
    const foreign = await app.request(
      "/admin/api/accounts",
      jsonRequest(
        { email: "x@example.com", password: "secret" },
        { method: "POST", headers: { origin: "https://evil.example" } },
      ),
    );
    assert.equal(foreign.status, 403);
    const body = (await foreign.json()) as any;
    assert.match(body.error.message, /Cross-origin/);

    // No Origin means a non-browser client; the legacy operator path stays
    // usable and reaches the route (which rejects the incomplete body).
    const legacy = await app.request(
      "/admin/api/accounts",
      jsonRequest({}, { method: "POST" }),
    );
    assert.equal(legacy.status, 400);
  } finally {
    if (previous === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previous;
  }
});

test("dashboard: logout clears the session cookie", async () => {
  const login = await app.request(
    "/admin/api/session",
    jsonRequest({ apiKey: ADMIN_KEY }, { method: "POST" }),
  );
  const cookie = sessionCookie(login);

  const logout = await app.request("/admin/api/session", {
    method: "DELETE",
    headers: { cookie },
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") || "", /Max-Age=0/);

  // Stateless sessions are valid until expiry; the browser drops the cookie on
  // Max-Age=0, so a subsequent request carries no credential and fails closed.
  const after = await app.request("/admin/api/session");
  assert.equal(after.status, 401);
});

test("dashboard: SSE sends an initial overview event", async () => {
  const response = await app.request(
    "/admin/api/events",
    bearer(ADMIN_KEY),
  );
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") || "",
    /text\/event-stream/,
  );

  const reader = response.body?.getReader();
  assert.ok(reader);
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  assert.match(text, /event: overview/);
  assert.match(text, /"accounts"/);
  await reader.cancel();
});
