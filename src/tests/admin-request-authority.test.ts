import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.API_KEY = "sk-authority-test-key";

import { app } from "../api/server.ts";
import { config } from "../core/config.ts";
import { metrics } from "../core/metrics.ts";
import { getInternalOrigin } from "../core/internal-origin.ts";
import { listSettings } from "../admin/settings.ts";
import { resetLoginThrottleForTests } from "../admin/login-throttle.ts";

const ADMIN_KEY = "sk-authority-test-key";
const EVIL = "evil.test:7936";

let savedKey: string | undefined;
let savedHost: string;

beforeEach(() => {
  resetLoginThrottleForTests();
  savedKey = process.env.API_KEY;
  savedHost = config.server.host;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.API_KEY;
  else process.env.API_KEY = savedKey;
  config.server.host = savedHost;
});

function jsonRequest(body: unknown, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return { ...init, headers, body: JSON.stringify(body) };
}

function settingValue(key: string): unknown {
  return listSettings().find((entry) => entry.key === key)?.value;
}

function peerEnv(address: string) {
  return { incoming: { socket: { remoteAddress: address } } };
}

test("authority: rebinding matrix — untrusted Host is refused regardless of Origin", async () => {
  delete process.env.API_KEY;
  const before = settingValue("rate_limit_requests");
  const origins: Array<string | null> = [
    null,
    `http://${EVIL}`,
    "http://other.example:7936",
    "null",
  ];
  for (const origin of origins) {
    const headers: Record<string, string> = { host: EVIL };
    if (origin !== null) headers.origin = origin;
    const res = await app.request(
      `http://${EVIL}/admin/api/settings`,
      jsonRequest(
        { values: { rate_limit_requests: 9999 } },
        { method: "PUT", headers },
      ),
    );
    assert.equal(res.status, 403, `origin=${origin}`);
  }
  assert.equal(settingValue("rate_limit_requests"), before);
});

test("authority: untrusted Host cannot read admin data or drive the API", async () => {
  delete process.env.API_KEY;
  const overview = await app.request(`http://${EVIL}/admin/api/overview`, {
    headers: { host: EVIL },
  });
  assert.equal(overview.status, 403);
  const models = await app.request(`http://${EVIL}/v1/models`, {
    headers: { host: EVIL },
  });
  assert.equal(models.status, 403);
});

test("authority: loopback authorities work with no configuration", async () => {
  for (const host of [
    "127.0.0.1:7936",
    "localhost:7936",
    "[::1]:7936",
    "localhost",
  ]) {
    const res = await app.request("/admin/api/overview", {
      headers: { host, authorization: `Bearer ${ADMIN_KEY}` },
    });
    assert.equal(res.status, 200, host);
  }
});

test("authority: no-key loopback legacy path is preserved", async () => {
  delete process.env.API_KEY;
  const res = await app.request(
    "/admin/api/accounts",
    jsonRequest({}, { method: "POST" }),
  );
  assert.equal(res.status, 400);
});

test("authority: explicit trusted hosts work; forwarded headers never widen trust", async () => {
  config.server.trustedHosts = ["proxy.example.com"];
  try {
    const ok = await app.request("/admin/api/overview", {
      headers: {
        host: "proxy.example.com",
        authorization: `Bearer ${ADMIN_KEY}`,
      },
    });
    assert.equal(ok.status, 200);

    const forwarded = await app.request(`http://${EVIL}/admin/api/overview`, {
      headers: {
        host: EVIL,
        "x-forwarded-host": "proxy.example.com",
        authorization: `Bearer ${ADMIN_KEY}`,
      },
    });
    assert.equal(forwarded.status, 403);

    const sub = await app.request("/admin/api/overview", {
      headers: {
        host: "sub.proxy.example.com",
        authorization: `Bearer ${ADMIN_KEY}`,
      },
    });
    assert.equal(sub.status, 403);

    const lookalike = await app.request("/admin/api/overview", {
      headers: {
        host: "proxy.example.com.evil.test",
        authorization: `Bearer ${ADMIN_KEY}`,
      },
    });
    assert.equal(lookalike.status, 403);
  } finally {
    config.server.trustedHosts = [];
  }
});

test("authority: a concrete bound host is trusted without configuration", async () => {
  config.server.host = "192.168.1.50";
  const res = await app.request("/admin/api/overview", {
    headers: {
      host: "192.168.1.50:7936",
      authorization: `Bearer ${ADMIN_KEY}`,
    },
  });
  assert.equal(res.status, 200);
  const other = await app.request("/admin/api/overview", {
    headers: {
      host: "192.168.1.51:7936",
      authorization: `Bearer ${ADMIN_KEY}`,
    },
  });
  assert.equal(other.status, 403);
});

test("authority: normalisation is exact and total", async () => {
  const { isTrustedAuthority } = await import("../core/trusted-hosts.ts");
  const accepted = [
    "localhost",
    "LOCALHOST:7936",
    "127.0.0.1",
    "127.0.0.1:80",
    "[::1]:7936",
    "::1",
    " localhost ",
    "0:0:0:0:0:0:0:1",
  ];
  for (const authority of accepted) {
    assert.equal(isTrustedAuthority(authority), true, authority);
  }
  const rejected = [
    "evil.test",
    "localhost.evil.test",
    "notlocalhost",
    "localhost.",
    "user@localhost:7936",
    "sub.localhost",
    "",
    "localhost:99999",
  ];
  for (const authority of rejected) {
    assert.equal(isTrustedAuthority(authority), false, authority);
  }
});

test("authority: no-key admin requires a loopback peer when the socket is known", async () => {
  delete process.env.API_KEY;
  const remote = await app.request(
    "/admin/api/settings",
    jsonRequest({ values: { rate_limit_requests: 8888 } }, { method: "PUT" }),
    peerEnv("203.0.113.9"),
  );
  assert.equal(remote.status, 403);

  const local = await app.request(
    "/admin/api/settings",
    jsonRequest({ values: { rate_limit_requests: 8888 } }, { method: "PUT" }),
    peerEnv("127.0.0.1"),
  );
  assert.equal(local.status, 200);

  const mapped = await app.request(
    "/admin/api/settings",
    jsonRequest({ values: { rate_limit_requests: 8888 } }, { method: "PUT" }),
    peerEnv("::ffff:127.0.0.1"),
  );
  assert.equal(mapped.status, 200);
});

test("authority: no-key session login is refused from a non-loopback peer", async () => {
  delete process.env.API_KEY;
  const res = await app.request(
    "/admin/api/session",
    jsonRequest({}, { method: "POST" }),
    peerEnv("203.0.113.9"),
  );
  assert.equal(res.status, 403);
});

test("authority: cross-origin and CSRF checks remain effective under a trusted Host", async () => {
  const login = await app.request(
    "/admin/api/session",
    jsonRequest({ apiKey: ADMIN_KEY }, { method: "POST" }),
  );
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie") || "";
  const match = /qpx_admin=([^;]+)/.exec(setCookie);
  assert.ok(match);
  const cookie = `qpx_admin=${match[1]}`;
  const { csrf } = (await login.json()) as { csrf: string };

  const foreign = await app.request(
    "/admin/api/settings",
    jsonRequest(
      { values: { rate_limit_requests: 7777 } },
      {
        method: "PUT",
        headers: {
          cookie,
          "x-csrf-token": csrf,
          origin: "https://evil.example",
          host: "localhost:7936",
        },
      },
    ),
  );
  assert.equal(foreign.status, 403);

  const noCsrf = await app.request(
    "/admin/api/settings",
    jsonRequest(
      { values: { rate_limit_requests: 7777 } },
      { method: "PUT", headers: { cookie, host: "localhost:7936" } },
    ),
  );
  assert.equal(noCsrf.status, 403);
});

test("authority: adapter self-fetch origin is trusted", async () => {
  const { isTrustedAuthority } = await import("../core/trusted-hosts.ts");
  const origin = new URL(getInternalOrigin());
  assert.equal(isTrustedAuthority(origin.host), true);

  const res = await app.request("/v1/models", {
    headers: { host: origin.host, authorization: `Bearer ${ADMIN_KEY}` },
  });
  assert.equal(res.status, 200);
});

test("authority: rejection is counted and logged without secrets", async () => {
  delete process.env.API_KEY;
  const before = metrics.get("requests.authority_rejected")?.value ?? 0;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  let res: Response;
  try {
    res = await app.request(
      `http://${EVIL}/admin/api/settings`,
      jsonRequest(
        { values: { rate_limit_requests: 6666 }, secret: "sk-do-not-log" },
        {
          method: "PUT",
          headers: { host: EVIL, authorization: "Bearer sk-do-not-log" },
        },
      ),
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(res.status, 403);
  const after = metrics.get("requests.authority_rejected")?.value ?? 0;
  assert.ok(after > before, "authority rejection counter must increment");
  const line = warnings.find((entry) => entry.includes("evil.test"));
  assert.ok(line, "expected a warn log naming the rejected authority");
  assert.match(line, /PUT/);
  assert.doesNotMatch(line, /sk-do-not-log/);
  assert.doesNotMatch(line, /6666/);
  const body = (await res.json()) as { error: { message: string } };
  assert.equal(body.error.message, "Request authority is not trusted");
});

test("authority: wildcard bind trusts loopback and declared hosts only", async () => {
  config.server.host = "0.0.0.0";
  delete process.env.API_KEY;
  const local = await app.request("/admin/api/overview", {
    headers: { host: "localhost:7936" },
  });
  assert.equal(local.status, 200);
  const foreign = await app.request(`http://${EVIL}/admin/api/overview`, {
    headers: { host: EVIL },
  });
  assert.equal(foreign.status, 403);
  const lan = await app.request("/admin/api/overview", {
    headers: { host: "192.168.1.50:7936" },
  });
  assert.equal(lan.status, 403);
});
