# Implementation Plan: Qwen Specialized Modes

**Feature**: `007-qwen-specialized-modes`
**Status**: Implemented
**Depends on**: 008 (async task persistence pattern)

## Upstream contract (verified against the Qwen web client)

The Qwen web frontend (`qwen-chat-fe` 0.3.38) exposes these chat types:

| Mode | `chat_type` | `sub_chat_type` | Notes |
| --- | --- | --- | --- |
| Deep Research (normal) | `deep_research` | `deep_research` | `feature_config.research_mode = "normal"` |
| Deep Research (advanced) | `deep_research` | `deep_research` | `feature_config.research_mode = "advance"` |
| Web Dev | `web_dev` | `web_dev` | Artifacts preview |
| Full-Stack | `web_dev` | `web_dev` | Same engine, full-stack prompt contract |
| Slides | `slides` | `slides` | `slides` phase plus PDF preview |

Relevant response phases: `ResearchPlanning`, `DeepThinking`, `deep_research_answer`,
`ReportGeneration`, `PdfMdGen`, `slides`. The existing stream layer already maps
unknown phases to reasoning, so only the known answer/thinking sets need updating.

## Architecture

1. **Static model catalog** (`src/core/specialized-modes.ts`). Maps the four
   public model IDs to a chat type and capabilities, and builds the
   `feature_config` overrides. The catalog is always advertised because the
   modes are a web-client capability, not a model-catalog entry; a request that
   the upstream rejects is translated into a stable capability error.
2. **Request routing.** `parseRequestBody` resolves the specialized definition
   after alias mapping. `chat/index.ts` forwards it through
   `acquireUpstreamStream`; `qwen.ts` uses the override instead of the
   `t2t`/`search` default.
3. **Stream phases.** `ResearchPlanning` joins the thinking phases so
   research plans surface as `reasoning_content`; `slides` joins the answer
   phases.
4. **Artifacts and citations.** `extractArtifacts()` parses markdown
   links/images and JSON URLs from the final answer, validates `http(s)`
   targets, deduplicates and classifies them as `report`, `pdf`, `image`, `code`
   or `link`. Task results expose the validated URLs as `citations[]` and the
   classified outputs as `artifacts[]`. Nothing is executed or fetched
   server-side. Upstream-signed URLs keep their upstream TTL; the API documents
   this.
5. **Async tasks** (`src/core/specialized-tasks.ts`,
   `src/routes/specialized-tasks.ts`).
   - `POST /v1/tasks` accepts a normal chat-completions body for a specialized
     model and returns a task immediately.
   - The worker calls the local `/v1/chat/completions` endpoint with
     `stream:false`, reusing account selection, quotas, cooldowns, retries and
     metrics. The caller's credential headers (`Authorization`, `x-api-key`,
     `x-goog-api-key`) and `X-QwenProxy-Research-Mode` are forwarded so the
     inner call authenticates exactly like the outer request.
   - `GET /v1/tasks/:id` returns status (`queued|running|succeeded|failed|
     cancelled`), progress and the result or stable error code.
   - `DELETE /v1/tasks/:id` aborts the local fetch and marks the task
     `cancelled`.
   - Tasks are stored in SQLite (`specialized_tasks`) so status survives client
     disconnects and restarts. Rows older than 7 days are pruned; tasks left
     `running` by a restart become `failed` with `code:"interrupted"`.
    - Active tasks are bounded per instance and per owner
      (`SPECIALIZED_TASK_MAX_ACTIVE_PER_USER`, default 4;
      `SPECIALIZED_TASK_MAX_ACTIVE`, default 32; `0` disables a cap) so
      unbounded background jobs cannot exhaust the process. Exceeding a cap
      returns 429 `task_limit_exceeded`.
    - A configurable deadline (`SPECIALIZED_TASK_TIMEOUT_MS`, default 30
      minutes) fails an over-running task with `code:"task_timeout"`, distinct
      from an explicit client cancellation.
6. **Capability errors.** A specialized model request with no configured
   account fails with `capability_unavailable` (400), and upstream
   model/authorization failures for specialized modes are mapped to
   `capability_unsupported` (400) instead of a generic 500.
7. **Observability.** Metrics use the existing request counters; logs include
   the mode but never the prompt or generated artifacts.

## Non-goals

- Re-hosting generated artifacts. URLs are passed through with a documented TTL
  and may be downloaded with `b64_json`-style retrieval in a later iteration.
- Executing generated code.
- Cross-instance task sharing. Tasks are local SQLite state; Redis task
  coordination is intentionally out of scope for this feature.

## Testing

- Unit: model mapping, feature config, reasoning effort to `research_mode`,
  artifact URL validation/classification, phase sets.
- Task store: create/status/result/failure/cancel/prune, ownership isolation.
- Route: capability error for a non-specialized model; async task lifecycle
  with an injected runner (no live upstream).
- Existing `/v1/chat/completions` mock suite must stay green.
