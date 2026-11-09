# Tasks: OpenAPI Contract and API Documentation

**Feature**: `012-openapi-contract-and-docs`
**Plan**: [plan.md](plan.md)
**Spec**: [spec.md](spec.md)

## Phase 1 — Contract coverage

- [x] T001 Audit every public Hono route and fill missing paths in
  `docs/openapi.yaml` (`/v1/completions`, Anthropic Messages and token
  counting, Responses retrieval/deletion, videos, task status, chat mode, logs,
  token diagnostics, `/openapi.json`, `/docs`).
- [x] T002 Add shared parameter, schema and response components
  (`ResponseId`, Anthropic request/response/error, legacy completion, video,
  chat mode, log, diagnostics and OpenAPI document).
- [x] T003 Document protocol-specific error envelopes (OpenAI, Anthropic,
  Gemini) and expand the tag list so every operation is categorized.

## Phase 2 — Runtime serving

- [x] T004 Add `src/api/docs.ts` with `resolveOpenApiPath`,
  `loadOpenApiDocument` (mtime-keyed cache), `resetOpenApiCacheForTesting`,
  `docsApp`, `GET /openapi.json` and `GET /docs`.
- [x] T005 Build the dependency-free HTML/CSS/JS viewer with tag grouping,
  filtering, per-operation "Try it" forms, SSE streaming and in-memory-only API
  key handling.
- [x] T006 Mount `docsApp` in `src/api/server.ts` and add `/openapi.json` and
  `/docs` to the public probe list.
- [x] T007 Add `yaml@^2.9.1`, ship `docs/openapi.yaml` in the npm `files` array,
  and keep the lockfile in sync.

## Phase 3 — Contract tests

- [x] T008 Add `src/tests/openapi-contract.test.ts` with OpenAPI 3.1 validity,
  component presence, secret scanning, public-route coverage, example/schema
  validation, served document and docs page checks, and error-envelope checks.
- [x] T009 Handle the shared Gemini `/v1beta/models/*` wildcard by asserting both
  `generateContent` and `streamGenerateContent` operations.
- [x] T010 Add the contract test to `test:mock` and `test:mock:fast`.

## Phase 4 — Documentation and verification

- [x] T011 Update `README.md` with the contract/docs endpoints and features;
  update `README.es.md` and `README.pt-BR.md`.
- [x] T012 Mark spec 012 implemented in `specs/README.md` and
  `docs/FEATURE-GAPS.md`.
- [x] T013 Run `npm run typecheck` and the focused contract test.
- [x] T014 Run `npm run test:mock` (full suite).
- [x] T015 Live-check `GET /openapi.json` and `GET /docs` on a running server.
- [x] T016 Commit and push the feature.
