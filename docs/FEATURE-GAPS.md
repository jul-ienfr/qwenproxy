# Feature Gap Analysis — QwenProxy (johngbl fork)

**Date**: 2026-11-07
**Baseline**: `jul-ienfr/qwenproxy`, fork of `johngbl/qwenproxy` 1.6.11
**Scope**: capabilities present in competing Qwen web-to-API projects but absent
or materially weaker in this project.

This document is the index for the Spec Kit feature specifications. It does not
authorize implementation by itself; each feature still needs its own spec, plan
and tasks.

## Method

Compared repositories (README, source, releases, live endpoint surface):

| Project | Why it matters |
| --- | --- |
| `Rfym21/Qwen2API` | Most complete actively maintained Qwen web gateway: HTTP transport, per-account proxy, context externalization, OpenAI + Anthropic, CLI endpoint, images/videos, Docker, native binaries. |
| `pedrofariasx/qwenproxy` | The original upstream. ISC, web dashboard, multi-user API keys with RPM/concurrency quotas, SQLite, hybrid sessions. |
| `YuJunZhiXue/qwen2API` | 970★ Go + React gateway with OpenAI + Anthropic + Gemini APIs and account pool. |
| `123hi123/qwen2api-rs` | Rust rewrite with OpenAI + Anthropic + Gemini, four-layer concurrency, warm pool, admin UI. |
| `encryptarun/qwen-api` | Token-passthrough Cloudflare Worker with image/video, Deep Research, Web Dev, Full-Stack, Slides, web search and citations. |
| `smanx/qwen2api` | Serverless-oriented Qwen Chat proxy with image generation, video analysis and built-in chat page. |
| `youssefvdel/qwengate` | Hybrid browser-login + HTTP transport, MIT, multi-account, dashboard, tools, file upload. |
| `y13sint/FreeQwenApi` | Browser-based multi-account proxy with images, videos, health and smoke tooling. |
| `xiaoY233/Chat2API` | Multi-provider desktop app (8 providers incl. Qwen CN/Global), OAuth, context management, dashboard. |

The comparison is feature-level, not a claim that every competitor is better.
Several competitors are stale, unlicensed or less secure; those weaknesses are
recorded in the prior research and are not repeated here.

## Gap matrix

Status values: `present` (already shipped), `partial` (some support but not the
full competitor capability), `missing`, `deferred` (assessed but not recommended
for this architecture).

| # | Capability | Current status | Evidence in competitors | Priority | Spec |
| --- | --- | --- | --- | --- | --- |
| 001 | Per-account outbound proxy (HTTP/SOCKS5), with account-level override and global fallback | **missing** | Rfym21: `account.proxy` > `PROXY_URL`; per-account IP rotation to avoid IP association bans | **P1** | [001](../specs/001-per-account-outbound-proxy/spec.md) |
| 002 | Multi-user API keys with RPM and concurrency quotas, admin/normal key roles | **missing** | pedrofariasx: `users` table, `rate_limit_rpm`, `max_concurrency`, `USER_API_KEYS`; 429 on quota | **P1** | [002](../specs/002-multi-user-api-keys-and-quotas/spec.md) |
| 003 | Authenticated web administration dashboard (accounts, keys, usage, settings, logs) | **missing** (TUI only) | pedrofariasx: React + shadcn `/admin`; Rfym21: WebUI; Chat2API: dashboard | **P1** | [003](../specs/003-web-admin-dashboard/spec.md) |
| 004 | Gemini-compatible API (`/v1beta/models/{model}:generateContent`, stream) | **missing** | YuJunZhiXue and 123hi123 expose OpenAI + Anthropic + Gemini | **P2** | [004](../specs/004-gemini-compatible-api/spec.md) |
| 005 | Web search toggle with citations/annotations | **missing** (`auto_search: false` hardcoded) | Rfym21 smart search; encryptarun search + clickable citations/annotations | **P2** | [005](../specs/005-web-search-and-citations/spec.md) |
| 006 | Image editing endpoint (`POST /v1/images/edits`) | **missing** (generation only) | Rfym21 `/v1/images/edits`; encryptarun image edit | **P2** | [006](../specs/006-image-editing/spec.md) |
| 007 | Qwen specialized modes: Deep Research, Web Dev, Full-Stack, Slides | **missing** | encryptarun exposes `qwen-deep-research`, `qwen-web-dev`, `qwen-full-stack`, `qwen-slides` | **P3** | [007](../specs/007-qwen-specialized-modes/spec.md) |
| 008 | Redis persistence and multi-instance coordination | **missing** (SQLite single process) | Rfym21 `DATA_SAVE_MODE=redis` + `REDIS_URL`; multi-worker Docker | **P2** | [008](../specs/008-redis-persistence-and-scaling/spec.md) |
| 009 | Runtime model mapping/aliases (env + admin surface) | **partial** (code-level alias only) | Rfym21 `MODEL_MAP` env + dashboard model mapping; Chat2API model mapping | **P3** | [009](../specs/009-runtime-model-mapping/spec.md) |
| 010 | Native binaries and multi-arch Docker distribution | **partial** (Docker image, npm) | Rfym21 Windows/Linux native binaries + multi-arch Docker; EasyCLIProxyAPI desktop | **P3** | [010](../specs/010-native-packaging-and-multiarch/spec.md) |
| 011 | Qwen Code CLI endpoint (`/cli`) with 256k context and native tools | **missing** | Rfym21 CLI endpoint; `qwen-code-oai-proxy` (now deprecated) | **P3 / conditional** | [011](../specs/011-qwen-cli-endpoint/spec.md) |
| 012 | OpenAPI 3.1 contract and interactive API docs | **missing** | encryptarun (`qwen.json` + hosted docs), Rfym21 API docs | **P2** | [012](../specs/012-openapi-contract-and-docs/spec.md) |
| 013 | Externalized-context cache and prefix reuse | **missing** (re-uploads every turn) | Rfym21 `AGENT_CONTEXT_PREFIX_REUSE`, TTL and max entries | **P2** | [013](../specs/013-externalized-context-cache/spec.md) |
| D1 | Serverless/edge stateless deployment | **deferred** | smanx (Vercel/Netlify/CF Workers), encryptarun (Cloudflare Worker) | **Not planned** | See "Deferred" below |

## Already present — not a gap

These competitor capabilities are already implemented and tested in the current
project:

- OpenAI Chat Completions, legacy Completions, OpenAI Responses and native
  Anthropic Messages (`/v1/messages`, `count_tokens`).
- Streaming SSE, tool calling, reasoning effort, thinking phases.
- Multi-account pool, load-aware rotation, cooldowns, failover, warm pool,
  shared Chromium with isolated contexts.
- Image generation, video generation, video task polling.
- Multimodal uploads via Qwen OSS.
- Hybrid sessions, personalization sync, large-context externalization (added
  2026-11-07: history attached as a Qwen text file above 90 KB).
- `/health`, Prometheus `/metrics`, structured logs, TUI.
- Docker and `docker compose` deployment.

## Deferred — assessed but not recommended

### Serverless/edge deployment (smanx, encryptarun)

**Why it exists elsewhere**: these projects use direct HTTP calls or a
token-passthrough model, which fits a stateless function.

**Why it is deferred here**: the current transport deliberately executes fetch
inside a real authenticated browser tab to inherit Qwen's Baxia headers, cookies
and fingerprint. Removing that dependency would reintroduce the direct-HTTP WAF
failures observed when Rfym21 was tested on this network (HTTP 405 at login,
HTTP 503 at chat). A serverless mode is a separate architecture, not a feature
slice. Revisit only if a validated HTTP-only transport becomes available.

## Recommended sequence

1. **001 per-account proxy** — removes the largest operational failure mode
   (IP-associated WAF) and unlocks safe multi-account scaling.
2. **002 multi-user quotas** — required before exposing the proxy to more than
   one operator; also the foundation for the dashboard.
3. **003 web dashboard** — makes accounts, quotas and usage operable without the
   TUI; depends on 002 for the user/key surfaces.
4. **013 externalized-context cache** — makes long agent sessions cheaper and
   less WAF-prone; builds on the externalization already shipped.
5. **005 web search** and **006 image editing** — high-value model capabilities
   with contained protocol work.
6. **004 Gemini API** — broadens client compatibility; depends on stable
   translation fixtures.
7. **012 OpenAPI contract** — locks the growing protocol surface.
8. **008 Redis** — only when a second instance or multi-worker deployment is
   actually needed.
9. **007, 009, 010, 011** — opportunistic improvements; 011 remains conditional
   on Qwen Code quota availability.

## Evidence and limitations

- Star counts and release dates were observed on 2026-11-07 and are not quality
  scores.
- Feature claims come from each project's README and source, not from a live
  interoperability test of every competitor.
- `Rfym21/Qwen2API` has no `LICENSE` file (ISC declared in `package.json`);
  reuse beyond personal fork requires author clarification.
- The current fork is ISC and keeps the upstream `LICENSE` and `NOTICE`.
