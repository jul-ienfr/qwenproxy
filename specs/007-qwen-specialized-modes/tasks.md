# Tasks: Qwen Specialized Modes

- [x] T001 Add `src/core/specialized-modes.ts` with the four model IDs, chat
  type mapping, feature-config builder and capability error helpers.
- [x] T002 Resolve specialized modes in `parseRequestBody` and expose the
  definition through the chat route.
- [x] T003 Thread `chatType` and `researchMode` through
  `acquireUpstreamStream` and `createQwenStream`; set `feature_config`
  accordingly instead of hardcoding `t2t`/`research_mode:"normal"`.
- [x] T004 Add `ResearchPlanning` to thinking phases and `slides` to answer
  phases.
- [x] T005 Extract and validate citations/artifacts from the final content.
- [x] T006 Advertise the four specialized models in `/v1/models` and
  `/v1/models/:model`.
- [x] T007 Add the `specialized_tasks` SQLite table with a 7-day prune and
  restart recovery.
- [x] T008 Add the task store and background worker (local non-stream
  completions call, caller auth forwarding, cancellation).
- [x] T009 Add `POST /v1/tasks`, `GET /v1/tasks/:id`, `DELETE /v1/tasks/:id`
  and register them in the server.
- [x] T010 Map unsupported upstream failures to a stable capability error.
- [x] T011 Add unit and route tests.
- [x] T012 Document the modes, task contract and artifact TTL in EN/FR
  READMEs and update the spec indexes.
- [x] T013 Run typecheck, focused tests, full mock suite and build.
- [x] T014 Cap active async tasks per API key and per instance (429
  `task_limit_exceeded`), with tests and env documentation.
- [x] T015 Make the task deadline configurable and report expiry as `failed`
  with `code:"task_timeout"`, distinct from cancellation.
- [x] T016 Forward `X-QwenProxy-Research-Mode` through async tasks and document
  it in OpenAPI.
- [x] T017 Reject malformed `POST /v1/tasks` bodies with a 400 instead of a
  generic 500.
- [x] T018 Forward `x-api-key` and `x-goog-api-key` credentials to the inner
  task call, not only `Authorization`.
- [x] T019 Require a non-empty `messages` array on `POST /v1/tasks` so invalid
  bodies fail synchronously with 400 instead of asynchronously.
