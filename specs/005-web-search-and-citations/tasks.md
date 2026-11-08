# Tasks: Web Search and Citations

**Feature**: `005-web-search-and-citations`
**Plan**: [plan.md](plan.md)
**Spec**: [spec.md](spec.md)

## Phase 1 — Core primitives

- [x] T001 Add `isSafeCitationUrl` and export `isBlockedHostname` in
  `src/core/safe-remote-url.ts` (http/https, no credentials, no local/private
  hosts, no DNS).
- [x] T002 Add `src/core/citations.ts`: source normalisation, dedupe, URL
  validation, `search_results`, URL-citation annotations and offset matching.
- [x] T003 Add combined `-search`/reasoning suffix parsing in
  `src/core/model-alias.ts`.
- [x] T004 Add `supportsSearch` derivation, defaults and `-search` base-id
  handling in `src/core/model-registry.ts`.

## Phase 2 — Request and payload plumbing

- [x] T005 Resolve the effective `webSearch` flag in
  `src/routes/chat/validation.ts` from body `web_search`,
  `web_search_options`, `X-QwenProxy-Web-Search` and the model suffix.
- [x] T006 Add `webSearch`/`webSearchChatType` to `AcquireParams` and forward
  them to `createQwenStream` in `src/routes/chat/account.ts`.
- [x] T007 Add `search`/`searchChatType` options to `createQwenStream`; set
  `auto_search` and `chat_type`/`sub_chat_type` only when enabled.
- [x] T008 Thread the flags through initial acquisition, outer retries,
  mid-stream recovery and malformed-tool retries.

## Phase 3 — Response integration

- [x] T009 Collect and merge `delta.extra.web_search_info` in both non-streaming
  and streaming loops; ignore the search metadata delta as content.
- [x] T010 Attach `annotations`/`search_results` to the non-streaming message,
  emit a final streaming metadata chunk before `finish_reason`, and expose the
  `search` outcome object.
- [x] T011 Set `X-QwenProxy-Web-Search` and add search metrics/warnings.
- [x] T012 Expose `supports_search` in `/v1/models` and keep the catalog free of
  synthetic `-search` duplicates.

## Phase 4 — Tests, docs and verification

- [x] T013 Add `src/tests/citations.test.ts` and extend suffix, registry and
  models-endpoint tests.
- [x] T014 Run `npm run typecheck` and the focused tests.
- [x] T015 Run `npm run test:mock` (full).
- [x] T016 Update `README.md`, `docs/FEATURE-GAPS.md` and `specs/README.md`.
- [x] T017 Live-probe search with citations; commit and push.
