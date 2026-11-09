import test from "node:test";
import assert from "node:assert/strict";
import {
  loginDashboard,
  type DashboardAuthSink,
  type DashboardCookie,
} from "../gui/dashboard-auth.ts";
import { resolveServerTarget } from "../gui/server-manager.ts";

function captureSink(): DashboardAuthSink & { cookies: DashboardCookie[] } {
  const cookies: DashboardCookie[] = [];
  return {
    cookies,
    setCookie: (cookie: DashboardCookie) => {
      cookies.push(cookie);
    },
  };
}

const SESSION_COOKIE =
  "qpx_admin=header.payload.signature; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=28800";

test("GUI dashboard auth: posts the key and injects the session cookie", async () => {
  const target = resolveServerTarget("0.0.0.0", 7936);
  const sink = captureSink();
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenInit = init;
    return new Response("{}", {
      status: 200,
      headers: { "set-cookie": SESSION_COOKIE },
    });
  }) as typeof fetch;

  const result = await loginDashboard(sink, {
    target,
    apiKey: "sk-test-key",
    fetch: fakeFetch,
  });

  assert.ok(result.ok);
  assert.equal(seenUrl, "http://127.0.0.1:7936/admin/api/session");
  assert.equal(seenInit?.method, "POST");
  assert.equal(
    (seenInit?.headers as Record<string, string>)["content-type"],
    "application/json",
  );
  assert.deepEqual(JSON.parse(String(seenInit?.body)), {
    apiKey: "sk-test-key",
  });
  assert.equal(sink.cookies.length, 1);
  assert.deepEqual(sink.cookies[0], {
    name: "qpx_admin",
    value: "header.payload.signature",
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "strict",
  });
});

test("GUI dashboard auth: never sends the key to a non-loopback host", async () => {
  const target = resolveServerTarget("192.168.1.20", 3000);
  const sink = captureSink();
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const result = await loginDashboard(sink, {
    target,
    apiKey: "sk-secret",
    fetch: fakeFetch,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "remote-host");
  assert.equal(called, false);
  assert.equal(sink.cookies.length, 0);
});

test("GUI dashboard auth: reports rejected credentials and sets no cookie", async () => {
  const target = resolveServerTarget("127.0.0.1", 7936);
  const sink = captureSink();
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ error: { message: "nope" } }), {
      status: 401,
      headers: { "set-cookie": SESSION_COOKIE },
    })) as typeof fetch;

  const result = await loginDashboard(sink, {
    target,
    apiKey: "wrong",
    fetch: fakeFetch,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "status-401");
  assert.equal(sink.cookies.length, 0);
});

test("GUI dashboard auth: a response without the session cookie is a failure", async () => {
  const target = resolveServerTarget("127.0.0.1", 7936);
  const sink = captureSink();
  const fakeFetch = (async () =>
    new Response("{}", {
      status: 200,
      headers: { "set-cookie": "other=value; Path=/" },
    })) as typeof fetch;

  const result = await loginDashboard(sink, {
    target,
    apiKey: "sk-test",
    fetch: fakeFetch,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing-cookie");
  assert.equal(sink.cookies.length, 0);
});

test("GUI dashboard auth: picks qpx_admin among multiple Set-Cookie headers", async () => {
  const target = resolveServerTarget("localhost", 7936);
  const sink = captureSink();
  const headers = new Headers();
  headers.append("set-cookie", "other=value; Path=/");
  headers.append("set-cookie", SESSION_COOKIE);
  const fakeFetch = (async () =>
    new Response("{}", { status: 200, headers })) as typeof fetch;

  const result = await loginDashboard(sink, {
    target,
    apiKey: "sk-test",
    fetch: fakeFetch,
  });

  assert.ok(result.ok);
  assert.equal(sink.cookies[0]?.value, "header.payload.signature");
  assert.equal(sink.cookies[0]?.domain, "localhost");
});

test("GUI dashboard auth: https targets get a secure cookie", async () => {
  const target = {
    ...resolveServerTarget("localhost", 8443),
    origin: "https://localhost:8443",
    healthUrl: "https://localhost:8443/health",
    dashboardUrl: "https://localhost:8443/admin",
  };
  const sink = captureSink();
  const fakeFetch = (async () =>
    new Response("{}", {
      status: 200,
      headers: { "set-cookie": SESSION_COOKIE },
    })) as typeof fetch;

  const result = await loginDashboard(sink, {
    target,
    apiKey: "sk-test",
    fetch: fakeFetch,
  });

  assert.ok(result.ok);
  assert.equal(sink.cookies[0]?.secure, true);
});

test("GUI dashboard auth: times out without throwing", async () => {
  const target = resolveServerTarget("127.0.0.1", 7936);
  const sink = captureSink();
  const fakeFetch = (async () => new Promise<Response>(() => {})) as typeof fetch;

  const result = await loginDashboard(sink, {
    target,
    apiKey: "sk-test",
    fetch: fakeFetch,
    timeoutMs: 10,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "timeout");
  assert.equal(sink.cookies.length, 0);
});

test("GUI dashboard auth: network errors are reported generically", async () => {
  const target = resolveServerTarget("127.0.0.1", 7936);
  const sink = captureSink();
  const fakeFetch = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as typeof fetch;

  const result = await loginDashboard(sink, {
    target,
    apiKey: "sk-test",
    fetch: fakeFetch,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "network-error");
});

test("GUI dashboard auth: a rejected cookie is reported without throwing", async () => {
  const target = resolveServerTarget("127.0.0.1", 7936);
  const sink: DashboardAuthSink = {
    setCookie: () => {
      throw new Error("unsupported domain");
    },
  };
  const fakeFetch = (async () =>
    new Response("{}", {
      status: 200,
      headers: { "set-cookie": SESSION_COOKIE },
    })) as typeof fetch;

  const result = await loginDashboard(sink, {
    target,
    apiKey: "sk-test",
    fetch: fakeFetch,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "cookie-rejected");
});
