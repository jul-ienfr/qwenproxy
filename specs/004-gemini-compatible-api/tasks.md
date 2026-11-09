# Tasks: Gemini-Compatible API

**Feature**: `004-gemini-compatible-api`
**Plan**: [plan.md](plan.md)
**Spec**: [spec.md](spec.md)

## Phase 1 — Types, validation and translation core

- [x] T001 Add `src/routes/gemini/types.ts` with the Gemini request/response
  shapes (`contents`, `systemInstruction`, `generationConfig`, `tools`,
  `candidates`, `usageMetadata`, error envelope) and the internal chat types they
  translate to and from.
- [x] T002 Add `src/routes/gemini/validation.ts`: structurally validate
  `contents`, parts, media, function calls, `systemInstruction`,
  `generationConfig`, `tools`, `toolConfig`, `safetySettings` and `stream`, while
  leaving approximated fields to the translator.
- [x] T003 Add `mapGeminiModel` and `isSupportedGeminiModel` in
  `src/routes/gemini/translate.ts`: alias Gemini tiers to Qwen, pass native Qwen
  ids through and preserve `-fast`/`-thinking`/`-search` suffixes.
- [x] T004 Translate Gemini `contents` into chat messages: system instruction,
  multi-turn roles (`model` -> assistant), text parts, `inlineData`/`fileData`
  media, function-call history and `functionResponse` round trips.
- [x] T005 Translate `generationConfig`: temperature, topP, topK, max output
  tokens, stop sequences, penalties, candidate count, seed, logprobs,
  `responseMimeType`/`responseSchema` and `thinkingConfig`, with warnings for
  fields the backend cannot honor.
- [x] T006 Translate `tools[].functionDeclarations` and
  `toolConfig.functionCallingConfig` into chat tools and tool choice, warning on
  unsupported Gemini built-in tools and allow-list restrictions.
- [x] T007 Translate a non-streaming chat completion into Gemini candidates,
  finish reason, model version and usage metadata in
  `translateOpenAIToGemini`.
- [x] T008 Parse and repair function-call arguments with `robustParseJSON`, emit
  thought parts from `reasoning_content` and handle empty candidates explicitly.

## Phase 2 — Streaming, HTTP routes and discovery

- [x] T009 Add `createGeminiStreamState`, `translateStreamChunk` and
  `finalizeGeminiStream`: emit text/thought deltas incrementally, accumulate
  tool-call deltas and emit exactly one terminal chunk.
- [x] T010 Add `truncateToTokenBudget` and enforce `maxOutputTokens` for both
  streaming and non-streaming responses, reporting emitted rather than
  pre-truncation usage.
- [x] T011 Add `POST /v1beta/models/{model}:generateContent` and
  `:streamGenerateContent` in `src/routes/gemini/index.ts`, including SSE
  headers, keep-alive heartbeat and client-abort handling.
- [x] T012 Add Gemini-shaped errors and status mapping
  (`INVALID_ARGUMENT`, `UNAUTHENTICATED`, `NOT_FOUND`, `RESOURCE_EXHAUSTED`,
  `INTERNAL`, etc.) for every Gemini route failure.
- [x] T013 Expose translation warnings through
  `X-QwenProxy-Gemini-Warnings` and structured warning/error logs so no
  unsupported field is silently dropped.
- [x] T014 Add `GET /v1beta/models` and `GET /v1beta/models/{model}` using the
  live Qwen catalog, context windows and output-token capabilities.
- [x] T015 Accept `Authorization: Bearer`, `x-api-key`, `x-goog-api-key` and
  `?key=` by reusing the central key extraction and user identity.
- [x] T016 Mount `geminiApp` in `src/index.ts` without changing the existing
  OpenAI, Anthropic or Responses routes.

## Phase 3 — Tests

- [x] T017 Add `src/tests/gemini.test.ts` covering model aliases, auth header
  extraction, structural validation, system/multi-turn translation, multimodal
  parts, tool declarations and round trips, generation config, warnings,
  non-streaming output, output budgets, finish reasons, incremental streaming,
  accumulated tool calls and empty candidates.
- [x] T018 Register `src/tests/gemini.test.ts` in both `npm run test:mock` and
  `npm run test:mock:fast`.

## Phase 4 — Documentation and verification

- [x] T019 Document the `/v1beta` paths, the `x-goog-api-key` scheme and the
  Gemini compatibility layer in `docs/openapi.yaml`.
- [x] T020 Update `README.md`, `docs/FEATURE-GAPS.md` and `specs/README.md` with
  the Gemini endpoints, aliases and warnings header.
- [x] T021 Run `npm run typecheck`, the focused Gemini suite and
  `npm run test:mock`.
- [x] T022 Commit and push the Gemini implementation (`d5f64b2`).
