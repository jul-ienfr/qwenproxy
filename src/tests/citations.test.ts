import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSearchOutcome,
  buildUrlCitationAnnotations,
  extractSearchInfo,
  isSearchMetadataDelta,
  mergeSearchSources,
  normalizeSearchSources,
  toSearchResults,
  webSearchHeaderValue,
} from "../core/citations.ts";
import { isSafeCitationUrl } from "../core/safe-remote-url.ts";
import {
  mapClientModelToQwen,
  parseModelSuffix,
} from "../core/model-alias.ts";
import { resolveWebSearch } from "../routes/chat/validation.ts";

test("parseModelSuffix understands -search alone and combined with reasoning", () => {
  assert.deepEqual(parseModelSuffix("qwen3.7-plus-search"), {
    baseModel: "qwen3.7-plus",
    enableThinking: true,
    reasoningMode: "auto",
    search: true,
  });
  assert.deepEqual(parseModelSuffix("qwen3.7-plus-thinking-search"), {
    baseModel: "qwen3.7-plus",
    enableThinking: true,
    reasoningMode: "thinking",
    search: true,
  });
  assert.deepEqual(parseModelSuffix("qwen3.7-plus-search-thinking"), {
    baseModel: "qwen3.7-plus",
    enableThinking: true,
    reasoningMode: "thinking",
    search: true,
  });
  assert.deepEqual(parseModelSuffix("qwen3.7-plus-search-low"), {
    baseModel: "qwen3.7-plus",
    enableThinking: false,
    reasoningMode: "fast",
    search: true,
  });
  assert.equal(parseModelSuffix("qwen3.7-plus").search, false);
  assert.equal(parseModelSuffix("qwen3.7-plus").baseModel, "qwen3.7-plus");
  assert.equal(mapClientModelToQwen("qwen3.7-plus-search"), "qwen3.7-plus");
});

function fakeContext(headerValue?: string) {
  return {
    req: {
      header: (name: string) =>
        name.toLowerCase() === "x-qwenproxy-web-search"
          ? headerValue
          : undefined,
    },
  } as any;
}

function body(value: Record<string, unknown>) {
  return { model: "qwen3.7-plus", messages: [], ...value } as any;
}

test("resolveWebSearch honours body, header, options and explicit false", () => {
  assert.equal(resolveWebSearch(fakeContext(), body({}), false), false);
  assert.equal(
    resolveWebSearch(fakeContext(), body({ web_search: true }), false),
    true,
  );
  assert.equal(
    resolveWebSearch(fakeContext("1"), body({}), false),
    true,
  );
  assert.equal(
    resolveWebSearch(fakeContext("false"), body({ web_search: true }), true),
    false,
  );
  assert.equal(
    resolveWebSearch(fakeContext(), body({ web_search: false }), true),
    false,
  );
  assert.equal(
    resolveWebSearch(fakeContext(), body({ web_search_options: {} }), false),
    true,
  );
  assert.equal(resolveWebSearch(fakeContext(), body({}), true), true);
});

test("resolveWebSearch rejects an invalid header value instead of ignoring it", () => {
  assert.throws(
    () => resolveWebSearch(fakeContext("sometimes"), body({}), false),
    /x-qwenproxy-web-search/,
  );
  // Empty header is equivalent to absent, not invalid.
  assert.equal(resolveWebSearch(fakeContext(""), body({}), false), false);
});

test("isSafeCitationUrl only accepts public http(s) URLs", () => {
  assert.equal(isSafeCitationUrl("https://example.com/a"), true);
  assert.equal(isSafeCitationUrl("http://example.org/b?x=1"), true);
  assert.equal(isSafeCitationUrl("javascript:alert(1)"), false);
  assert.equal(isSafeCitationUrl("file:///etc/passwd"), false);
  assert.equal(isSafeCitationUrl("http://localhost/x"), false);
  assert.equal(isSafeCitationUrl("http://127.0.0.1/x"), false);
  assert.equal(isSafeCitationUrl("http://[::1]/x"), false);
  assert.equal(isSafeCitationUrl("https://user:pass@example.com/x"), false);
  assert.equal(isSafeCitationUrl("not a url"), false);
});

test("normalizeSearchSources validates, dedupes and indexes", () => {
  const sources = normalizeSearchSources([
    { title: "A", url: "https://example.com/a", hostname: "example.com" },
    { title: "B", url: "http://example.org/b" },
    { title: "A duplicate", url: "https://example.com/a" },
    { title: "bad", url: "javascript:alert(1)" },
    { title: "local", url: "http://localhost/secret" },
  ]);

  assert.equal(sources.length, 2);
  assert.deepEqual(sources[0], {
    index: 1,
    title: "A",
    url: "https://example.com/a",
    hostname: "example.com",
  });
  assert.equal(sources[1].index, 2);
  assert.equal(sources[1].hostname, "example.org");
  assert.equal(sources[1].title, "B");
});

test("mergeSearchSources keeps first-seen order across chunks", () => {
  const first = normalizeSearchSources([
    { title: "A", url: "https://example.com/a" },
  ]);
  const merged = mergeSearchSources(first, [
    { title: "B", url: "https://example.org/b" },
    { title: "A again", url: "https://example.com/a" },
  ]);
  assert.deepEqual(
    merged.map((source) => source.url),
    ["https://example.com/a", "https://example.org/b"],
  );
  assert.deepEqual(
    merged.map((source) => source.index),
    [1, 2],
  );
});

test("buildUrlCitationAnnotations finds markdown, raw URLs and numeric markers", () => {
  const sources = normalizeSearchSources([
    { title: "A", url: "https://example.com/a" },
    { title: "B", url: "http://example.org/b" },
  ]);
  const content =
    "See [source A](https://example.com/a) and the second source [2].";

  const annotations = buildUrlCitationAnnotations(content, sources);
  assert.equal(annotations.length, 2);
  assert.equal(annotations[0].type, "url_citation");
  assert.equal(
    content.slice(
      annotations[0].url_citation.start_index,
      annotations[0].url_citation.end_index,
    ),
    "[source A](https://example.com/a)",
  );
  assert.equal(
    content.slice(
      annotations[1].url_citation.start_index,
      annotations[1].url_citation.end_index,
    ),
    "[2]",
  );

  const rawUrlAnnotations = buildUrlCitationAnnotations(
    "Visit https://example.com/a for details",
    sources,
  );
  assert.equal(
    rawUrlAnnotations[0].url_citation.start_index,
    "Visit ".length,
  );
});

test("buildUrlCitationAnnotations falls back to 0,0 and search_results keeps sources", () => {
  const sources = normalizeSearchSources([
    { title: "A", url: "https://example.com/a" },
  ]);
  const annotations = buildUrlCitationAnnotations("No reference here", sources);
  assert.equal(annotations[0].url_citation.start_index, 0);
  assert.equal(annotations[0].url_citation.end_index, 0);
  assert.deepEqual(toSearchResults(sources), [
    {
      index: 1,
      title: "A",
      url: "https://example.com/a",
      hostname: "example.com",
    },
  ]);
});

test("search metadata helpers expose requested/ran/source count", () => {
  const sources = normalizeSearchSources([
    { title: "A", url: "https://example.com/a" },
  ]);
  assert.deepEqual(buildSearchOutcome(true, sources), {
    requested: true,
    ran: true,
    source_count: 1,
  });
  assert.deepEqual(buildSearchOutcome(true, []), {
    requested: true,
    ran: false,
    source_count: 0,
  });
  assert.equal(webSearchHeaderValue(false, []), "not_requested");
  assert.equal(webSearchHeaderValue(true, null), "requested");
  assert.equal(webSearchHeaderValue(true, []), "no_results");
  assert.equal(webSearchHeaderValue(true, sources), "ran");
});

test("extractSearchInfo reads Qwen web_search deltas", () => {
  const info = [{ title: "A", url: "https://example.com/a" }];
  const delta = { name: "web_search", extra: { web_search_info: info } };
  assert.equal(isSearchMetadataDelta(delta), true);
  assert.equal(extractSearchInfo(delta), info);
  assert.equal(
    extractSearchInfo({}, { choices: [{ delta: { extra: { web_search_info: info } } }] }),
    info,
  );
});
