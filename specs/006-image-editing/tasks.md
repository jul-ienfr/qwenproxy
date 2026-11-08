# Tasks: Image Editing Endpoint

**Feature**: `006-image-editing`
**Plan**: [plan.md](plan.md)
**Spec**: [spec.md](spec.md)

## Phase 1 — Primitives

- [x] T001 Add `ContentPolicyError` (400, `content_policy_violation`) in
  `src/core/errors.ts`.
- [x] T002 Add `uploadBufferAsQwenFile` in `src/routes/upload.ts` with an
  explicit MIME override; delegate `uploadTextAsQwenFile` to it.
- [x] T003 Export `buildCompletionsPayload`, widen chat types to
  `image_edit`, and add `detectMediaContentPolicyError` in
  `src/services/media-generation.ts`.

## Phase 2 — Service edit path

- [x] T004 Add `edit?: { buffer, filename, mime }` to `generateImage`; use
  `image_edit` for chat creation and completions payloads.
- [x] T005 Upload the input image per attempt via
  `uploadBufferAsQwenFile` and attach the returned file entry to
  `messages[0].files`.
- [x] T006 Do not forward `size` upstream for edits; keep the accepted value
  for OpenAI compatibility.
- [x] T007 Map moderation bodies (JSON and SSE) and upstream 403s to
  `ContentPolicyError`; rethrow immediately without account cooldown/retry.

## Phase 3 — HTTP surface

- [x] T008 Add `imagesEdits` in `src/routes/images.ts`: multipart parsing,
  required `prompt`/`image`, 20MB cap, PNG/JPEG/WebP/GIF allow-list with
  magic-byte sniffing, `n`, `size`, `response_format`, and default model
  `qwen-image-3.0-pro`.
- [x] T009 Reject `mask` with a documented 400 limitation and reject models
  without `i2i` support (video models, `z-image-turbo`).
- [x] T010 Return the OpenAI Images shape and download `b64_json` only after
  `assertSafeRemoteMediaUrl` plus a byte cap.
- [x] T011 Register `POST /v1/images/edits` in `src/api/server.ts`.

## Phase 4 — Tests, docs and verification

- [x] T012 Add `src/tests/image-edit.test.ts`: capability checks, policy
  detection, multipart validation, upstream payload assertions, and policy
  mapping. Register it in both mock test scripts.
- [x] T013 Document the endpoint in `README.md`, `docs/openapi.yaml`,
  `docs/FEATURE-GAPS.md` and `specs/README.md`.
- [x] T014 Run `npm run typecheck`, the focused test, the full mock suite and
  a live edit request with `url` and `b64_json`.
- [x] T015 Commit and push to `origin/main`.
