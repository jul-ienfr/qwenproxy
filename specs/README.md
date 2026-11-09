# QwenProxy — Spec Kit Feature Backlog

This directory contains the Spec Kit feature specifications for capabilities
that exist in competing Qwen web-to-API projects but are missing or materially
weaker in this fork. The evidence and priority rationale live in
[`docs/FEATURE-GAPS.md`](../docs/FEATURE-GAPS.md).

**SDD status**: specifications are drafted. `plan.md` and `tasks.md` are created
per feature when the feature is scheduled for implementation, using the Spec Kit
commands installed in `.opencode/commands/` and `.dsh/skills/`.

## Index

| # | Specification | Priority | Depends on | Status |
| --- | --- | --- | --- | --- |
| 001 | [Per-account outbound proxy](001-per-account-outbound-proxy/spec.md) | P1 | — | Implemented (egress + failover verified) |
| 002 | [Multi-user API keys and quotas](002-multi-user-api-keys-and-quotas/spec.md) | P1 | — | Implemented (live-verified) |
| 003 | [Web administration dashboard](003-web-admin-dashboard/spec.md) | P1 | 002 | Implemented (live-verified) |
| 004 | [Gemini-compatible API](004-gemini-compatible-api/spec.md) | P2 | — | Implemented (generateContent + SSE, function calling, model aliases) |
| 005 | [Web search and citations](005-web-search-and-citations/spec.md) | P2 | — | Implemented (opt-in search, URL citations) |
| 006 | [Image editing](006-image-editing/spec.md) | P2 | — | Implemented (multipart edit, content-policy mapping) |
| 007 | [Qwen specialized modes](007-qwen-specialized-modes/spec.md) | P3 | 008 for async tasks | Draft |
| 008 | [Redis persistence and scaling](008-redis-persistence-and-scaling/spec.md) | P2 | — | Draft |
| 009 | [Runtime model mapping](009-runtime-model-mapping/spec.md) | P3 | 003 for UI | Implemented (`MODEL_MAP`, hot reload, admin API/dashboard) |
| 010 | [Native packaging and multi-arch](010-native-packaging-and-multiarch/spec.md) | P3 | — | Draft |
| 011 | [Qwen CLI endpoint](011-qwen-cli-endpoint/spec.md) | P3 / conditional | Qwen Code quota | Draft |
| 012 | [OpenAPI contract and docs](012-openapi-contract-and-docs/spec.md) | P2 | — | Implemented (contract tests + offline docs) |
| 013 | [Externalized-context cache](013-externalized-context-cache/spec.md) | P2 | 001 for account isolation | Implemented (prefix reuse + TTL/LRU) |

## Recommended implementation order

1. **001** per-account proxy — root-cause mitigation for IP-associated WAF.
2. **002** multi-user keys and quotas — required before sharing the proxy.
3. **003** web dashboard — operational surface for 001/002.
4. **013** externalized-context cache — makes long agent sessions cheaper and
   less WAF-prone; builds on the externalization already shipped.
5. **005** web search — high-value model capability with contained scope.
6. **006** image editing — completes the Images API surface.
7. **004** Gemini API — broadens client compatibility.
8. **012** OpenAPI contract — locks the growing protocol surface.
9. **008** Redis — only when a second instance is actually needed.
10. **007**, **009**, **010**, **011** — opportunistic and conditional.

## How to run the Spec Kit flow

OpenCode commands are installed under `.opencode/commands/`:

```text
/speckit.specify
/speckit.clarify
/speckit.plan
/speckit.tasks
/speckit.analyze
/speckit.implement
/speckit.converge
```

DeepSeek Harness skills are installed under `.dsh/skills/`:

```text
/speckit-specify
/speckit-plan
/speckit-tasks
/speckit-implement
```

The project constitution is at
[`.specify/memory/constitution.md`](../.specify/memory/constitution.md).

## Scope notes

- Specs 001–011 describe *missing* capabilities. They do not re-specify existing
  behavior (OpenAI, Anthropic, Responses, tools, images, videos, multi-account,
  TUI, metrics, large-context externalization).
- Serverless/edge deployment is assessed but intentionally deferred; see the
  "Deferred" section of the gap analysis.
- Each spec is written to be independently testable even if later specs are not
  implemented.
