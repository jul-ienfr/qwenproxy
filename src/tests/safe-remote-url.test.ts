import test from "node:test";
import assert from "node:assert/strict";
import type { LookupAddress, LookupOptions } from "node:dns";
import {
  UnsafeRemoteUrlError,
  assertSafeRemoteMediaUrl,
  createSafeLookup,
  fetchSafeRemoteMedia,
  isPrivateOrLocalIp,
} from "../core/safe-remote-url.ts";

test("safe-remote-url: private IP detection", () => {
  assert.equal(isPrivateOrLocalIp("127.0.0.1"), true);
  assert.equal(isPrivateOrLocalIp("10.0.0.8"), true);
  assert.equal(isPrivateOrLocalIp("192.168.1.1"), true);
  assert.equal(isPrivateOrLocalIp("169.254.169.254"), true);
  assert.equal(isPrivateOrLocalIp("::1"), true);
  assert.equal(isPrivateOrLocalIp("8.8.8.8"), false);
});

test("safe-remote-url: blocks localhost, metadata, and file URLs", async () => {
  await assert.rejects(
    () => assertSafeRemoteMediaUrl("http://127.0.0.1/secret"),
    UnsafeRemoteUrlError,
  );
  await assert.rejects(
    () => assertSafeRemoteMediaUrl("http://localhost/admin"),
    UnsafeRemoteUrlError,
  );
  await assert.rejects(
    () => assertSafeRemoteMediaUrl("http://169.254.169.254/latest/meta-data/"),
    UnsafeRemoteUrlError,
  );
  await assert.rejects(
    () => assertSafeRemoteMediaUrl("file:///etc/passwd"),
    UnsafeRemoteUrlError,
  );
});

function runLookup(
  lookup: ReturnType<typeof createSafeLookup>,
  hostname: string,
  options: LookupOptions = {},
): Promise<{ address: string | LookupAddress[]; family?: number }> {
  return new Promise((resolve, reject) => {
    lookup(hostname, options, (err, address, family) => {
      if (err) reject(err);
      else resolve({ address, family });
    });
  });
}

test("safe-remote-url: connection lookup rejects private addresses", async () => {
  const lookup = createSafeLookup(async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.7", family: 4 },
  ]);
  await assert.rejects(
    () => runLookup(lookup, "rebind.example"),
    (err: unknown) =>
      err instanceof UnsafeRemoteUrlError &&
      /private address/.test(err.message),
  );
});

test("safe-remote-url: connection lookup rejects empty resolution", async () => {
  const lookup = createSafeLookup(async () => []);
  await assert.rejects(
    () => runLookup(lookup, "empty.example"),
    UnsafeRemoteUrlError,
  );
});

test("safe-remote-url: connection lookup pins the first public address", async () => {
  const lookup = createSafeLookup(async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ]);
  const single = await runLookup(lookup, "public.example");
  assert.equal(single.address, "93.184.216.34");
  assert.equal(single.family, 4);

  const all = await runLookup(lookup, "public.example", { all: true });
  assert.deepEqual(all.address, [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ]);
});

test("safe-remote-url: fetchSafeRemoteMedia rejects unsafe URLs before dialing", async () => {
  await assert.rejects(
    () => fetchSafeRemoteMedia("http://127.0.0.1/secret"),
    UnsafeRemoteUrlError,
  );
  await assert.rejects(
    () => fetchSafeRemoteMedia("http://[::1]/secret"),
    UnsafeRemoteUrlError,
  );
  await assert.rejects(
    () => fetchSafeRemoteMedia("ftp://example.com/file"),
    UnsafeRemoteUrlError,
  );
  await assert.rejects(
    () => fetchSafeRemoteMedia("http://user:pass@example.com/file"),
    UnsafeRemoteUrlError,
  );
});
