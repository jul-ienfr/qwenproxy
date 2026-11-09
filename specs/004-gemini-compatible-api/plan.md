# Implementation Plan: Gemini-Compatible API

**Branch**: `004-gemini-compatible-api` | **Date**: 2026-11-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-gemini-compatible-api/spec.md`

## Summary

Expose the Gemini Generative Language REST surface
(`/v1beta/models/{model}:generateContent` and `:streamGenerateContent`) as a
translation layer over the existing OpenAI chat pipeline. Requests are validated
and translated from Gemini `contents`, `systemInstruction`, `generationConfig`
and `tools` into the internal chat shape; responses are translated back into
`candidates`, `content.parts`, `finishReason` and `usageMetadata`, including
function calls, thought parts and SSE streaming. Unsupported fields are reported
through `X-QwenProxy-Gemini-Warnings` and structured logs instead of being
silently dropped. Model discovery is exposed in Gemini format, Gemini model
families are aliased to Qwen tiers, and the existing OpenAI, Anthropic and
Responses routes are untouched.

## Technical Context

**Language/Version**: TypeScript on Node.js 22+

**Primary Dependencies**: existing proxy core only (`hono`, `hono/streaming`,
model registry and alias modules); no new runtime dependency

**Storage**: none; the adapter is stateless and delegates all state to the
existing chat pipeline

**Testing**: `node:test` via tsx; `src/tests/gemini.test.ts` covers model
mapping, validation, request/response translation, streaming, tool calls,
output budgets and warnings, plus the existing mock suite and typecheck gate

**Target Platform**: Windows and Linux, Docker-compatible

**Project Type**: Single TypeScript service with TUI and HTTP API

**Performance Goals**: Translation is linear in request size; streaming emits
text/thought deltas immediately and accumulates tool-call deltas until the
single terminal event, so no extra buffering of the visible answer is needed

**Constraints**: Gemini routes must keep the OpenAI/Anthropic/Responses
contracts unchanged, return Gemini-shaped errors, accept `x-goog-api-key`,
`x-api-key`, Bearer and `?key=`, and report unsupported fields observably

**Scale/Scope**: REST `generateContent` compatibility only; no Vertex AI
proprietary features, explicit context caching or built-in Gemini tools

## Constitution Check

- **Upstream compatibility**: Gemini requests are translated into the existing
  `/v1/chat/completions` path; no second execution path. PASS.
- **Browser-transport fidelity**: the adapter dispatches through the internal
  chat route, preserving the browser transport, account pool and retries. PASS.
- **Account isolation**: the internal route keeps the normal account selection,
  rotation and failover behavior. PASS.
- **Spec-driven**: spec, plan and tasks accompany the implemented code. PASS.
- **Observability**: `X-QwenProxy-Gemini-Warnings` plus structured warning/error
  logs make every approximated or ignored field observable. PASS.
- **Tests**: focused Gemini suite, mock suite and typecheck gate. PASS.
- **Security**: authentication reuses the central key extraction and user
  identity path; no new credential handling. PASS.
- **Simplicity**: one self-contained adapter (`types`, `validation`,
  `translate`, `index`) over the existing chat core. PASS.

## Project Structure

```text
src/
├── routes/gemini/
│   ├── index.ts        # Hono routes, auth, errors, streaming, model discovery
│   ├── translate.ts    # Gemini <-> OpenAI request/response/stream translation
│   ├── types.ts        # Gemini and internal chat types
│   └── validation.ts   # structural request validation
├── core/
│   ├── auth-identity.ts # x-goog-api-key / x-api-key / Bearer / ?key= extraction
│   ├── model-alias.ts   # Gemini tier aliases and -fast/-thinking/-search suffixes
│   └── model-registry.ts # context window and output-token capabilities
├── index.ts            # mounts geminiApp
└── tests/
    └── gemini.test.ts
specs/004-gemini-compatible-api/
├── plan.md
├── tasks.md
└── spec.md
docs/
├── openapi.yaml        # /v1beta paths and x-goog-api-key scheme
└── FEATURE-GAPS.md
```

## Integration Points

1. `extractProvidedApiKeys` accepts `Authorization: Bearer`, `x-api-key`,
   `x-goog-api-key` and the `?key=` query parameter; `getUserIdentity` gates the
   routes.
2. `mapGeminiModel` maps `gemini-*pro*` to `qwen3.8-max`, `gemini-*flash*` to
   `qwen3.7-plus`, passes native Qwen ids through and preserves
   `-fast`/`-thinking`/`-search` suffixes.
3. `validateGeminiRequest` rejects structural errors with Gemini-shaped `400`
   errors while leaving approximated fields to the translator.
4. `translateGeminiToOpenAI` flattens system instructions, multi-turn contents,
   multimodal parts, tool history, generation config and tool choice, recording a
   `TranslationWarning` for every lossy field.
5. `dispatchToChat` posts to the local `/v1/chat/completions` route with the
   server API key, forwarding chat-mode and session-affinity headers.
6. `translateOpenAIToGemini` and `translateStreamChunk`/`finalizeGeminiStream`
   produce Gemini candidates, thought parts, function calls and usage metadata;
   `truncateToTokenBudget` enforces `maxOutputTokens` because the Qwen web
   backend has no hard output limit.
7. `GET /v1beta/models` and `GET /v1beta/models/{model}` expose the live Qwen
   catalog in Gemini format using the model registry capabilities.

## Phases

- Phase 1 — types, validation and translation core.
- Phase 2 — HTTP routes, authentication, error envelope and model discovery.
- Phase 3 — focused tests and test-script registration.
- Phase 4 — OpenAPI/README documentation, full verification and release.

## Complexity Tracking

No constitution violations. The added complexity is one isolated adapter
package plus thin registration in the main router; the chat core is unchanged.
