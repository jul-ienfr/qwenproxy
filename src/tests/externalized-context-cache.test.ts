import test from "node:test";
import assert from "node:assert/strict";

import {
  ExternalizedContextCache,
  computeExternalizedContextVariantHash,
  hashUtf8Prefix,
  sliceUtf8Tail,
  type CachedUpload,
} from "../services/externalized-context-cache.ts";

function fakeFile(id = "file-1"): any {
  return {
    type: "file",
    file: {
      created_at: 1,
      data: {},
      filename: "ctx.txt",
      hash: null,
      id,
      user_id: "proxy-user",
      meta: { name: "ctx.txt", size: 1, content_type: "text/plain" },
      update_at: 1,
      lastModified: 1,
      name: "ctx.txt",
      webkitRelativePath: "",
      size: 1,
      type: "text/plain",
    },
    id,
    url: `https://example.test/${id}`,
    name: "ctx.txt",
    collection_name: "",
    progress: 100,
    status: "uploaded",
    greenNet: "success",
    size: 1,
    error: "",
    itemId: id,
  };
}

function storeText(
  cache: ExternalizedContextCache,
  accountId: string,
  variantHash: string,
  text: string,
  fileId = "file-1",
): CachedUpload {
  return cache.store({
    accountId,
    variantHash,
    prompt: Buffer.from(text, "utf8"),
    filename: "ctx.txt",
    file: fakeFile(fileId),
  });
}

test("lookup misses on an empty cache", () => {
  const cache = new ExternalizedContextCache();
  assert.equal(
    cache.lookup("acc", "v", Buffer.from("User: hello\n\n")),
    null,
  );
  assert.equal(cache.stats().misses, 1);
});

test("lookup reuses a stored prefix and reports the covered bytes", () => {
  const cache = new ExternalizedContextCache();
  const prefix = "User: hello\n\nAssistant: hi\n\n";
  storeText(cache, "acc", "v", prefix);

  const prompt = Buffer.from(`${prefix}User: next\n\n`, "utf8");
  const hit = cache.lookup("acc", "v", prompt);

  assert.ok(hit);
  assert.equal(hit.prefixBytes, Buffer.byteLength(prefix, "utf8"));
  assert.equal(hit.entry.file.id, "file-1");
  assert.equal(cache.stats().hits, 1);
  assert.equal(cache.stats().reusedBytes, hit.prefixBytes);
});

test("lookup returns null for a divergent history", () => {
  const cache = new ExternalizedContextCache();
  storeText(cache, "acc", "v", "User: alpha\n\n");
  assert.equal(
    cache.lookup("acc", "v", Buffer.from("User: beta\n\n", "utf8")),
    null,
  );
});

test("lookup prefers the longest matching prefix", () => {
  const cache = new ExternalizedContextCache();
  storeText(cache, "acc", "v", "abcdef", "short");
  storeText(cache, "acc", "v", "abcdefgh", "long");

  const hit = cache.lookup("acc", "v", Buffer.from("abcdefghXYZ", "utf8"));
  assert.ok(hit);
  assert.equal(hit.entry.file.id, "long");
  assert.equal(hit.prefixBytes, 8);
});

test("entries are isolated per account", () => {
  const cache = new ExternalizedContextCache();
  storeText(cache, "account-a", "v", "shared prefix", "file-a");

  assert.equal(
    cache.lookup("account-b", "v", Buffer.from("shared prefix!", "utf8")),
    null,
  );
  const hit = cache.lookup(
    "account-a",
    "v",
    Buffer.from("shared prefix!", "utf8"),
  );
  assert.ok(hit);
  assert.equal(hit.entry.file.id, "file-a");
});

test("entries are isolated per variant (tools/personalization/proxy)", () => {
  const cache = new ExternalizedContextCache();
  storeText(cache, "acc", "variant-a", "shared prefix");

  assert.equal(
    cache.lookup("acc", "variant-b", Buffer.from("shared prefix!", "utf8")),
    null,
  );
});

test("entries expire after the TTL", () => {
  let now = 1_000;
  const cache = new ExternalizedContextCache({ ttlMs: 60_000, now: () => now });
  storeText(cache, "acc", "v", "prefix");

  now += 59_999;
  assert.ok(cache.lookup("acc", "v", Buffer.from("prefix more", "utf8")));

  now += 1; // exactly TTL
  assert.equal(
    cache.lookup("acc", "v", Buffer.from("prefix more", "utf8")),
    null,
  );
  assert.equal(cache.stats().ttlExpirations, 1);
});

test("LRU eviction keeps the most recently used entries", () => {
  const cache = new ExternalizedContextCache({ maxEntries: 2 });
  storeText(cache, "acc", "v", "aaa", "f-a");
  storeText(cache, "acc", "v", "bbb", "f-b");

  // Touch "aaa" so "bbb" becomes the least recently used.
  assert.ok(cache.lookup("acc", "v", Buffer.from("aaa!", "utf8")));

  storeText(cache, "acc", "v", "ccc", "f-c");

  assert.equal(cache.stats().evictions, 1);
  assert.equal(
    cache.lookup("acc", "v", Buffer.from("bbb!", "utf8")),
    null,
  );
  assert.ok(cache.lookup("acc", "v", Buffer.from("aaa!", "utf8")));
  assert.ok(cache.lookup("acc", "v", Buffer.from("ccc!", "utf8")));
});

test("single-flight serializes tasks sharing a key", async () => {
  const cache = new ExternalizedContextCache();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = cache.withLock("acc:v", async () => {
    order.push("first-start");
    await gate;
    order.push("first-end");
    return 1;
  });
  const second = cache.withLock("acc:v", async () => {
    order.push("second-start");
    return 2;
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ["first-start"]);
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});

test("single-flight releases the lock after a failure", async () => {
  const cache = new ExternalizedContextCache();
  await assert.rejects(
    cache.withLock("k", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await cache.withLock("k", async () => "ok"), "ok");
});

test("invalidation removes entries and counts them", () => {
  const cache = new ExternalizedContextCache();
  const entry = storeText(cache, "acc", "v", "prefix", "f-1");
  storeText(cache, "acc", "other-variant", "prefix", "f-2");

  assert.equal(cache.invalidateEntry(entry.id, "test"), true);
  assert.equal(cache.invalidateEntry(entry.id, "test"), false);
  assert.equal(cache.stats().invalidations, 1);
  assert.equal(cache.stats().entries, 1);

  assert.equal(cache.invalidateVariant("acc", "other-variant", "test"), 1);
  assert.equal(cache.stats().entries, 0);
});

test("invalidateAccount scopes by account", () => {
  const cache = new ExternalizedContextCache();
  storeText(cache, "a", "v", "one");
  storeText(cache, "a", "v", "two");
  storeText(cache, "b", "v", "three");

  assert.equal(cache.invalidateAccount("a", "test"), 2);
  assert.equal(cache.stats().entries, 1);
});

test("store replaces an identical entry without growing the cache", () => {
  const cache = new ExternalizedContextCache();
  const first = storeText(cache, "acc", "v", "same", "f-1");
  const second = storeText(cache, "acc", "v", "same", "f-2");

  assert.equal(first.id, second.id);
  assert.equal(cache.stats().entries, 1);
  assert.equal(cache.stats().uploads, 2);
});

test("variant hash covers personalization and proxy changes", () => {
  const base = computeExternalizedContextVariantHash("tools=1", "http://p:1");
  assert.equal(
    computeExternalizedContextVariantHash("tools=1", "http://p:1"),
    base,
  );
  assert.notEqual(
    computeExternalizedContextVariantHash("tools=2", "http://p:1"),
    base,
  );
  assert.notEqual(
    computeExternalizedContextVariantHash("tools=1", "http://p:2"),
    base,
  );
});

test("hashUtf8Prefix matches a full-content hash for the whole buffer", () => {
  const prompt = Buffer.from("héllo wörld", "utf8");
  assert.equal(
    hashUtf8Prefix(prompt, prompt.length),
    hashUtf8Prefix(prompt, prompt.length + 100),
  );
  assert.notEqual(
    hashUtf8Prefix(prompt, prompt.length - 1),
    hashUtf8Prefix(prompt, prompt.length),
  );
});

test("sliceUtf8Tail never starts inside a multi-byte code point", () => {
  const prompt = Buffer.from("aaaébbb", "utf8");
  // "é" is two bytes; a naive 4-byte tail would start on its continuation byte.
  const tail = sliceUtf8Tail(prompt, 4);
  assert.equal(tail.toString("utf8"), "bbb");
});

test("cached entries retain no conversation text", () => {
  const cache = new ExternalizedContextCache();
  const secret = "TOPSECRET-CONVERSATION-CONTENT";
  storeText(cache, "acc", "v", `User: ${secret}\n\n`);

  const hit = cache.lookup(
    "acc",
    "v",
    Buffer.from(`User: ${secret}\n\nUser: next`, "utf8"),
  );
  assert.ok(hit);
  const serialized = JSON.stringify(hit.entry);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("prompt"), false);
});

test("stats report hits, misses, uploads and entry count", () => {
  const cache = new ExternalizedContextCache();
  storeText(cache, "acc", "v", "prefix");
  cache.lookup("acc", "v", Buffer.from("prefix+", "utf8"));
  cache.lookup("acc", "v", Buffer.from("nope", "utf8"));
  cache.recordRefresh();

  const stats = cache.stats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.refreshes, 1);
  assert.equal(stats.uploads, 1);
  assert.equal(stats.entries, 1);
});
