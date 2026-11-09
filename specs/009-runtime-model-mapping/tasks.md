# Tasks: Runtime Model Mapping and Aliases

**Input**: `specs/009-runtime-model-mapping/spec.md`

**Prerequisites**: plan.md

## Phase 1 - Core mapping store

- [x] T001 Add `getModelMappingsPath()` to `src/core/paths.ts`.
- [x] T002 Create `src/core/model-mapping.ts` with `MODEL_MAP` parsing,
      validation, atomic persistence, mtime cache, and hot-path lookups.
- [x] T003 Seed the store from `MODEL_MAP` when no persistence file exists;
      reject alias chains/cycles and reserved suffixes.
- [x] T004 Reject Qwen-prefixed alias keys and never apply the wildcard to
      native ids (`qwen*`, `wan*`, `z-image*`).

## Phase 2 - Protocol integration

- [x] T005 Apply exact runtime mapping before built-in aliases and the
      wildcard fallback in `mapClientModelToQwen`.
- [x] T006 Apply the same precedence in `mapAnthropicModel`.
- [x] T007 Reuse `mapClientModelToQwen` in `mapGeminiModel`.
- [x] T008 Log the requested/effective model at debug level when a runtime
      mapping applies.
- [x] T009 Confirm legacy `/v1/completions` inherits mapping through the
      internal chat dispatch.

## Phase 3 - Catalog and capabilities

- [x] T010 Append alias entries to `loadModelsWithVariants()` with target
      context window and capabilities.
- [x] T011 Resolve alias metadata in the Anthropic model catalog shape.
- [x] T012 Keep the `/v1/models` ETag stable and mapping-sensitive.

## Phase 4 - Admin surface

- [x] T013 Add `GET/PUT/DELETE /admin/api/model-mappings`.
- [x] T014 Reject invalid payloads with actionable HTTP 400 errors and write
      audit records for success/failure.
- [x] T015 Add a dashboard editor in the Settings tab.
- [x] T016 Document `MODEL_MAP`, the admin API, and hot reload in `.env.example`
      and the READMEs.

## Phase 5 - Verification

- [x] T017 Add unit tests for parsing, validation, precedence, native-id
      passthrough, and hot reload.
- [x] T018 Add admin API tests for GET/PUT/DELETE, invalid payloads, audit,
      and reset behavior.
- [x] T019 Add `/v1/models` tests for alias advertisement and target metadata.
- [x] T020 Add protocol tests for OpenAI/Anthropic/Gemini model resolution.
- [x] T021 Run `npm run typecheck`, focused tests, and the full
      `npm run test:mock` suite.
- [x] T022 Update spec status/docs and commit/push to `origin/main`.
