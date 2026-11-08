# Implementation Plan: Image Editing Endpoint

**Branch**: `006-image-editing` | **Date**: 2026-11-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/006-image-editing/spec.md`

## Summary

Add `POST /v1/images/edits` to the existing Images API surface. The endpoint
accepts multipart form data with a base `image` and `prompt`, validates the
upload locally (PNG/JPEG/WebP/GIF, 20MB), uploads the bytes through the existing
Qwen OSS helper, and calls the media pipeline with an `image_edit` chat type.
Everything after upload reuses the proven generation loop: account selection,
cooldowns, quotas, Node/browser transport fallback, Baxia captcha recovery and
metrics. The OpenAI response shape (`created` + `data[]`) and `url`/`b64_json`
formats are preserved. Upstream moderation is mapped to a stable
`ContentPolicyError` (400, `content_policy_violation`) and is never retried.
Masks are rejected with a documented limitation because the Qwen backend does
not accept them.

## Technical Context

**Language/Version**: TypeScript on Node.js 22+

**Primary Dependencies**: existing proxy core only (`hono`, `uuid`, Node
`fetch`, `File`/`FormData`); no new runtime dependency

**Storage**: no new storage; input files are uploaded to Qwen OSS and only kept
in memory for the duration of the request

**Testing**: `node:test` via tsx; route validation tests through `app.fetch`
with real multipart bodies, plus a service-level success/policy test with
mocked `getstsToken`, `chats/new` and `chat/completions` fetches

**Target Platform**: Windows and Linux, Docker-compatible

**Project Type**: Single TypeScript service with TUI and HTTP API

**Performance Goals**: One OSS upload per edit attempt; `n > 1` fans out to
parallel edit calls, matching generation behavior. No extra work for requests
that fail validation before upload.

**Constraints**: `size` is accepted but not forwarded upstream for edits;
`mask` is rejected (400). Content-policy failures are deterministic and must
not mark the account as rate-limited. Existing generation behavior and tests
must remain unchanged.

**Scale/Scope**: Per-request endpoint; no new global settings.

## Constitution Check

- **Upstream compatibility**: generation payloads are unchanged; the edit path
  adds `chat_type: image_edit`, attaches the uploaded file to
  `messages[0].files`, and omits the top-level `size` field.
- **Account safety**: reuses `getNextAvailableAccount`, cooldown handling,
  captcha recovery and metrics. Content-policy failures rethrow immediately.
- **Security**: multipart-only input, 20MB cap, MIME allow-list plus magic-byte
  sniffing, sanitized filename, and safe remote URL checks before any
  `b64_json` download.
- **Compatibility**: OpenAI Images response shape and `url`/`b64_json`
  semantics are preserved, including `n`.

## Project Structure

### Documentation (this feature)

```text
specs/006-image-editing/
  spec.md
  plan.md
  tasks.md
```

### Source Code

```text
src/core/errors.ts                 ContentPolicyError
src/routes/upload.ts               uploadBufferAsQwenFile
src/services/media-generation.ts   generateImage edit path + policy detection
src/routes/images.ts               imagesEdits route
src/api/server.ts                  route registration
src/tests/image-edit.test.ts       validation + upstream payload/policy tests
docs/openapi.yaml                  Images paths and schemas
README.md                          feature + endpoint table
```

## Phase Plan

1. **Upload primitive** — factor `uploadBufferAsQwenFile` out of
   `uploadTextAsQwenFile` with an explicit MIME override.
2. **Policy error** — add `ContentPolicyError` and `detectMediaContentPolicyError`.
3. **Service edit path** — extend `generateImage` with an optional `edit`
   input; upload per attempt, build an `image_edit` payload, skip `size`,
   detect moderation, and avoid retrying policy failures.
4. **Route** — parse and validate multipart input, enforce the default model,
   reject masks, run `n` edits in parallel, and render `url`/`b64_json`.
5. **Wiring and docs** — register the route, extend OpenAPI/README/backlog.
6. **Verification** — typecheck, focused tests, full mock suite, live edit
   against the running server, then commit and push.

## Risks and Mitigations

- **Upstream edit shape drift**: covered by asserting `chat_type`, `files` and
  absence of `size` in the service test.
- **MIME spoofing**: accepted MIME is checked against magic bytes when present.
- **Policy false positives**: detection requires both an error code/message and
  a policy keyword; rate-limit payloads are explicitly covered by a negative
  test.
- **Mask expectations**: documented and rejected up front instead of silently
  ignoring the parameter.
