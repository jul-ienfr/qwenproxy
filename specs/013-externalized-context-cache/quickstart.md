# Quickstart: Externalized Context Cache

**Feature**: `013-externalized-context-cache`

## Enable and tune

Defaults keep the cache on with a one-hour TTL and 64 entries. Override in
`.env`:

```bash
QWEN_EXTERNALIZE_CONTEXT_ENABLED=true
QWEN_EXTERNALIZE_CONTEXT_BYTES=90000
QWEN_EXTERNALIZE_LIVE_PROMPT_BYTES=49152
QWEN_EXTERNALIZE_CACHE_ENABLED=true
QWEN_EXTERNALIZE_CACHE_TTL_SECONDS=3600
QWEN_EXTERNALIZE_CACHE_MAX_ENTRIES=64
```

Disable only the cache (legacy upload-every-turn) with
`QWEN_EXTERNALIZE_CACHE_ENABLED=false`. Disabling externalization disables the
cache as well.

## Observe

Logs (no conversation text):

```text
[Chat] Context cache hit | account=a***@example.com | prefix=214533b new=842b file=qwenproxy-context-...txt | age=12s
[Chat] Context cache refresh | account=a***@example.com | prefix=214533b new=61234b | reason=delta-exceeds-live-budget
[Chat] Context externalized | account=a***@example.com | bytes=214533 | file=... | cache=stored
[Chat] Context cache invalidated | account=a***@example.com | reason=invalid_input
```

Prometheus (`GET /metrics`):

```text
externalized_context.cache.hit 12
externalized_context.cache.miss 3
externalized_context.cache.reused_bytes 2418921
externalized_context.cache.entries 2
```

Metric names keep dots, matching the rest of the registry.

## Verify prefix reuse

1. Send a request above `QWEN_EXTERNALIZE_CONTEXT_BYTES` with tools declared.
2. Send the same request with one extra assistant/user turn appended.
3. Expect the second response log to show `Context cache hit` and no new
   `Context externalized` upload line for that turn.
4. Force failover to another account and expect a per-account upload.
5. Lower `QWEN_EXTERNALIZE_CACHE_TTL_SECONDS` and confirm the next turn misses
   after expiry.

## Tests

```bash
npx tsx --test --env-file=.env.test src/tests/externalized-context-cache.test.ts
npm run typecheck
npm run test:mock
```

## Troubleshooting

- **No hits**: the personalization/tool instructions or the account proxy
  changed (`variantHash`), the TTL expired, or the delta exceeded
  `QWEN_EXTERNALIZE_LIVE_PROMPT_BYTES` and triggered a refresh.
- **Repeated 400 invalid_input after a hit**: the retry layer drops files and
  invalidates the account's entries, forcing a fresh upload on the next turn.
- **Memory growth**: reduce `QWEN_EXTERNALIZE_CACHE_MAX_ENTRIES`; only metadata
  is stored, so the bound is small.
