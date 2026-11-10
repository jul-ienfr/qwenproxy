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
