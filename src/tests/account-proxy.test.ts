import { test } from "node:test";
import assert from "node:assert/strict";
import {
  maskProxyUrl,
  parseAccountProxyEnv,
  parseProxyUrl,
  resolveProxyUrl,
  toPlaywrightProxy,
} from "../core/proxy-config.ts";

test("proxy-config: accepts http, https, socks5 and socks5h", () => {
  for (const url of [
    "http://proxy.example.com:8080",
    "https://proxy.example.com:8443",
    "socks5://proxy.example.com:1080",
    "socks5h://proxy.example.com:1080",
  ]) {
    const parsed = parseProxyUrl(url);
    assert.ok(parsed, `expected ${url} to parse`);
    assert.equal(parsed.username, undefined);
  }
});

test("proxy-config: decodes percent-encoded credentials", () => {
  const parsed = parseProxyUrl(
    "http://user%40name:p%40ss%3Aword@proxy.example.com:8080",
  );
  assert.ok(parsed);
  assert.equal(parsed.username, "user@name");
  assert.equal(parsed.password, "p@ss:word");
  assert.equal(parsed.server, "http://proxy.example.com:8080");
});

test("proxy-config: rejects unsupported schemes", () => {
  assert.throws(() => parseProxyUrl("file:///etc/passwd"), /Unsupported proxy scheme/);
  assert.throws(() => parseProxyUrl("ftp://proxy.example.com:21"), /Unsupported proxy scheme/);
});

test("proxy-config: rejects missing port and path/query", () => {
  assert.throws(() => parseProxyUrl("http://proxy.example.com"), /missing port/);
  assert.throws(() => parseProxyUrl("http://proxy.example.com:8080/path"), /path, query/);
  assert.throws(() => parseProxyUrl("http://proxy.example.com:8080?x=1"), /path, query/);
});

test("proxy-config: masks credentials", () => {
  assert.equal(
    maskProxyUrl("http://user:secret@proxy.example.com:8080"),
    "http://user:***@proxy.example.com:8080",
  );
  assert.equal(maskProxyUrl(""), "(direct)");
  assert.equal(maskProxyUrl("not a url"), "(invalid proxy URL)");
});

test("proxy-config: conversion keeps Playwright credentials separate", () => {
  const proxy = toPlaywrightProxy("http://user:pass@proxy.example.com:8080");
  assert.deepEqual(proxy, {
    server: "http://proxy.example.com:8080",
    username: "user",
    password: "pass",
  });
});

test("proxy-config: normalizes socks5h to the Playwright socks5 scheme", () => {
  assert.deepEqual(toPlaywrightProxy("socks5h://proxy.example.com:1080"), {
    server: "socks5://proxy.example.com:1080",
  });
});

test("proxy-config: account proxy wins over global fallback", () => {
  const previous = process.env.PROXY_URL;
  process.env.PROXY_URL = "http://global.example.com:3128";
  try {
    assert.equal(
      resolveProxyUrl("http://account.example.com:8080"),
      "http://account.example.com:8080",
    );
  } finally {
    if (previous === undefined) delete process.env.PROXY_URL;
    else process.env.PROXY_URL = previous;
  }
});

test("proxy-config: parses QWEN_ACCOUNT_PROXIES and ignores invalid entries", () => {
  const map = parseAccountProxyEnv(
    "A@example.com=http://proxy-a:8080; B@example.com=socks5://proxy-b:1080; bad-entry; C@example.com=file:///x",
  );
  assert.equal(map.get("a@example.com"), "http://proxy-a:8080");
  assert.equal(map.get("b@example.com"), "socks5://proxy-b:1080");
  assert.equal(map.has("c@example.com"), false);
  assert.equal(map.size, 2);
});
