# QwenProxy — Spec Kit Feature Backlog

This directory contains the Spec Kit feature specifications for capabilities
that exist in competing Qwen web-to-API projects but are missing or materially
weaker in this fork. The evidence and priority rationale live in
[`docs/FEATURE-GAPS.md`](../docs/FEATURE-GAPS.md).

**SDD status**: specifications are drafted. `plan.md` and `tasks.md` are created
per feature when the feature is scheduled for implementation, using the Spec Kit
commands installed in `.opencode/commands/` and `.dsh/skills/`.

**Backlog status (2026-11-16)**: every *capability* spec is implemented except
**011**, which is deferred because its free-Qwen-Code-quota precondition no longer
exists. **016** is a hardening epic, not a capability, and is **planned, not
implemented**.

**Defect fix (2026-11-16)**: spec **015** (tool-call arguments JSON integrity) is
implemented after a client rejected a `write` call with `JSON Parse error: Invalid
escape character l`. It is a correctness fix to the streaming tool-call path, not
a feature gap; symptom, cause, fix and verification are recorded in
[research.md](015-tool-call-json-integrity/research.md). Verified at the time:
typecheck clean, new integrity suites 23/23, regression set 160/160
(latest run includes the post-review split-branch hardening; `.tmp/015-splitfix.log`).

> **Baseline correction (audit 2026-11-16, repaired by 016 T001–T008)**: the
> `test:mock` **1211/1211** figure previously recorded here no longer reproduced
> on `a9da064`: the audit run measured **1210 tests, 1209 pass, 1 fail**
> (250 626 ms). The failure was `server-lifecycle.test.ts` raising `Unable to
> deserialize cloned data due to invalid or unsupported version.` with every
> frame inside `node:internal/test_runner/runner` — a test-runner
> reporting-channel defect, **not** a product assertion. Two consecutive
> reproduction runs were green (**1212/1212** each), proving the failure
> **intermittent**, not order-dependent; product console output is now silenced
> inside that test file (assertions unchanged, 3/3 in isolation).
> Separately, **10 test files (43 assertions)** appeared in no runner list at
> all, including the entire multi-user key / quota / migration surface of specs
> 001–002. The gate is now derived from a single manifest
> (`scripts/run-tests.mjs`): `npm test` is hermetic (mock only, live opt-in) and
> executes **172 files / 1321 tests, 1321 pass, 0 fail** (186 946 ms), including
> the 10 formerly orphaned suites, the manifest regression suite, and the eight
> suites added by 016 (authority, escape table, hot-path budgets, extractor
> equivalence, process-guard exit policy, quota load retry, shutdown ordering).
> Evidence: [docs/AUDIT-2026-11-16.md](../docs/AUDIT-2026-11-16.md) §7 and
> [016 research.md D2/D3](016-engineering-hardening/research.md).

**Hardening epic (2026-11-16)**: spec **016** (engineering hardening) is drafted
with plan, research, two contracts, 68 tasks and a quickstart, derived from an
exhaustive audit ([docs/AUDIT-2026-11-16.md](../docs/AUDIT-2026-11-16.md)). It
closes one **critical** security defect (DNS rebinding → full admin on a default
loopback install), removes quadratic cost from the streaming hot path, makes
shutdown/crash/quota transitions recoverable, encrypts Qwen session secrets at
rest, and makes module boundaries and the test gate mechanically enforceable.
**Status: In progress — Phases 1–7 complete; Phase 8 complete except T064 (boundary
ratchet at 0 forbidden edges, 8 of 8 repaired, 2 import cycles tracked; package entry
point; CI gates for lint, dependency audit, boundaries and build; `noUnusedLocals`
enabled after 45 dead symbols removed; Biome lint added). Phase 9 T065 done (p99 +
event-loop delay). Gate: 1332/1332 green, `npm run lint:ci` clean on 365 files,
boundary check 0 forbidden / 2 known cycles / 0 new, `npm run build` green. Every
budget in `contracts/hot-path-budget.md` (B1–B9) has a counter-backed assertion.
Remaining: `noUncheckedIndexedAccess` (636 errors), T064 (file splits), and
T066–T068.**

## Index

| # | Specification | Priority | Depends on | Status |
| --- | --- | --- | --- | --- |
| 001 | [Per-account outbound proxy](001-per-account-outbound-proxy/spec.md) | P1 | — | Implemented (egress + failover verified) |
| 002 | [Multi-user API keys and quotas](002-multi-user-api-keys-and-quotas/spec.md) | P1 | — | Implemented (live-verified) |
| 003 | [Web administration dashboard](003-web-admin-dashboard/spec.md) | P1 | 002 | Implemented (live-verified) |
| 004 | [Gemini-compatible API](004-gemini-compatible-api/spec.md) | P2 | — | Implemented (generateContent + SSE, function calling, model aliases) |
| 005 | [Web search and citations](005-web-search-and-citations/spec.md) | P2 | — | Implemented (opt-in search, URL citations) |
| 006 | [Image editing](006-image-editing/spec.md) | P2 | — | Implemented (multipart edit, content-policy mapping) |
| 007 | [Qwen specialized modes](007-qwen-specialized-modes/spec.md) | P3 | 008 for async tasks | Implemented (virtual models, `/v1/tasks`, citations/artifacts) |
| 008 | [Redis persistence and scaling](008-redis-persistence-and-scaling/spec.md) | P2 | — | Implemented (shared state, migration CLI, degraded `/health`, 2-instance compose) |
| 009 | [Runtime model mapping](009-runtime-model-mapping/spec.md) | P3 | 003 for UI | Implemented (`MODEL_MAP`, hot reload, admin API/dashboard) |
| 010 | [Native packaging and multi-arch](010-native-packaging-and-multiarch/spec.md) | P3 | — | Implemented (Bun binaries + checksums + multi-arch Docker) |
| 011 | [Qwen CLI endpoint](011-qwen-cli-endpoint/spec.md) | P3 / conditional | Qwen Code quota | Deferred (free OAuth quota discontinued; Qwen Code now subscription-only) |
| 012 | [OpenAPI contract and docs](012-openapi-contract-and-docs/spec.md) | P2 | — | Implemented (contract tests + offline docs) |
| 013 | [Externalized-context cache](013-externalized-context-cache/spec.md) | P2 | 001 for account isolation | Implemented (prefix reuse + TTL/LRU) |
| 014 | [Desktop tray and webview](014-desktop-tray-webview/spec.md) | P3 | 003 for dashboard | Implemented (tray + webview + auto-login; interactive smoke verified) |
| 015 | [Tool-call arguments JSON integrity](015-tool-call-json-integrity/spec.md) | P1 | — | Implemented (defect fix; incident 2026-11-16) |
| 016 | [Engineering hardening](016-engineering-hardening/spec.md) | P1 | 015 (parser invariants preserved) | Draft (audit-driven epic; 7 stories, 68 tasks; **not implemented**) |

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
9. **008** Redis — implemented; enable it only when a second instance is
   actually needed.
10. **011** — deferred: the free Qwen Code OAuth quota was discontinued around
    2026-04-15 and Qwen Code now requires a Plus/Pro subscription. All other
    specs (001–010 and 012–014) are implemented, so the backlog is closed.

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
