# Implementation Plan: Web Search and Citations

**Branch**: `005-web-search-and-citations` | **Date**: 2026-11-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/005-web-search-and-citations/spec.md`

## Summary

Make Qwen web search opt-in per request and expose the sources it returns as
OpenAI-compatible URL citations. Search can be requested through a body flag
(`web_search`), the presence of `web_search_options`, the
`X-QwenProxy-Web-Search` header, or a `-search` model suffix. The effective flag
is threaded from request parsing through account acquisition, transparent
retries and response assembly. Every opt-in path uses Qwen's `search` chat type
and sets `feature_config.auto_search`; search-disabled requests keep `t2t` and
`auto_search: false` (live probing showed that `auto_search: true` with `t2t`
does not actually run a search). Upstream `web_search_info` events are
normalised, URL-validated and returned as `annotations` plus the documented
`search_results` extension; the response also reports whether search ran.

## Technical Context

**Language/Version**: TypeScript 6.0 on Node.js 22+

**Primary Dependencies**: existing proxy core only (`node:net`, `node:url`,
`node:crypto`); no new runtime dependency

**Storage**: none; search state lives only for the duration of one request

**Testing**: `node:test` via tsx; unit tests for suffix parsing, request opt-in,
URL validation, source normalisation, annotation offsets and capability
derivation, plus the existing mock chat suite

**Target Platform**: Windows and Linux, Docker-compatible

**Project Type**: Single TypeScript service with TUI and HTTP API

**Performance Goals**: Citation normalisation is O(sources × answer length) with
small source counts (typically < 20); search-disabled requests do no extra work
beyond reading the parsed flags.

**Constraints**: Search is off by default; disabled requests must keep
`auto_search: false`. Citation URLs are never fetched; validation stays
synchronous. No query contents may be logged at info level.

**Scale/Scope**: Per-request opt-in only; no global search setting.

## Constitution Check

- **Upstream compatibility**: the payload shape is unchanged except for the
  explicit search flags; all non-search requests keep `t2t` and
  `auto_search: false`. PASS.
- **Browser-transport fidelity**: search still uses the existing chat
  completions stream; no new transport path. PASS.
- **Account isolation**: search is a per-request flag and follows the selected
  account through failover/retry. PASS.
- **Spec-driven**: plan, tasks and tests accompany the spec. PASS.
- **Observability**: response header/metadata, reports of `ran`/`no_results`,
  warnings for unsafe URLs and dedicated metrics; no query logging. PASS.
- **Tests**: focused unit tests plus the existing mock suite and typecheck gate.
  PASS.
- **Security**: citation URLs are restricted to http(s), without credentials,
  and cannot target localhost/private/link-local hosts. PASS.
- **Simplicity**: one focused citation module and thin plumbing through the
  existing request pipeline. PASS.

## Project Structure

```text
src/
├── core/
│   ├── citations.ts                    # source normalisation + annotations
│   ├── model-alias.ts                  # combined -search/reasoning suffixes
│   ├── model-registry.ts               # supportsSearch capability
│   ├── safe-remote-url.ts              # synchronous citation URL check
│   └── metrics.ts                      # search.* series
├── api/
│   └── models.ts                       # supports_search in /v1/models
├── routes/chat/
│   ├── validation.ts                   # opt-in flag resolution
│   ├── index.ts                        # thread webSearch through attempts
│   ├── account.ts                      # AcquireParams + createQwenStream
│   └── streaming.ts                    # capture sources, emit citations
├── services/
│   └── qwen.ts                         # payload auto_search/chat_type
└── tests/
    ├── citations.test.ts
    ├── model-alias.test.ts
    ├── model-registry-thinking.test.ts
    └── models-endpoint.test.ts
specs/005-web-search-and-citations/
├── plan.md
├── tasks.md
└── spec.md
```

## Integration Points

1. `parseRequestBody` resolves the effective `webSearch` flag from body, header,
   `web_search_options` and the model suffix; explicit false values win.
2. `AcquireParams` carries `webSearch`; the Qwen payload sets `auto_search`
   and uses `chat_type`/`sub_chat_type: "search"` whenever search is enabled.
3. All acquire call sites (initial, outer retry, mid-stream recovery, malformed
   tool retry) forward the same search flags.
4. `processNonStreamingResponse` and `processStreamingResponse` collect
   `delta.extra.web_search_info`, normalise/dedupe sources, and attach
   `annotations` + `search_results`.
5. Search outcome is exposed through `X-QwenProxy-Web-Search` and the final
   `search` metadata object.
6. `ModelCapabilities.supportsSearch` is derived from upstream metadata and
   exposed as `supports_search` in `/v1/models`.

## Phases

- Phase 1 — citation module, URL validation, suffix parsing and capability.
- Phase 2 — request opt-in and payload/retry plumbing.
- Phase 3 — response integration (streaming + non-streaming) and observability.
- Phase 4 — tests, docs, full verification and live probe.

## Complexity Tracking

No constitution violations. The added complexity is one pure module plus a
small amount of state threaded through the existing request/retry pipeline.
