# Feature Specification: Image Editing Endpoint

**Feature Branch**: `006-image-editing`

**Created**: 2026-11-07

**Status**: Draft

**Input**: Gap analysis vs `Rfym21/Qwen2API` (`/v1/images/edits`) and
`encryptarun/qwen-api` (image editing). The current project exposes
`/v1/images/generations` but no edit endpoint.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Edit an image with a prompt (Priority: P1)

A client uploads an image and a text instruction and receives an edited image
through the OpenAI Images API shape.

**Why this priority**: Image editing is a core multimodal capability and is
already supported by the Qwen web backend; the missing piece is the proxy
surface.

**Independent Test**: Upload a small PNG with the prompt "make the background
blue", call the edit endpoint, and verify a valid PNG/JPEG response and a
different image hash.

**Acceptance Scenarios**:

1. **Given** a multipart request with `image`, `prompt` and `model`, **When** the
   upstream succeeds, **Then** the response contains `data[0].url` or
   `data[0].b64_json`.
2. **Given** the same image and prompt twice, **Then** both requests complete
   independently and do not corrupt each other.
3. **Given** an unsupported image type, **Then** the response is 400 with a
   supported-format list.

---

### User Story 2 - Preserve OpenAI image parameters (Priority: P2)

A client can pass `size`, `n`, `response_format` and a mask where supported.

**Why this priority**: Clients expect the OpenAI Images API contract; silent
ignores break UX.

**Independent Test**: Request `size=1024x1024`, `response_format=b64_json` and
verify the output shape and dimensions where the upstream honors them.

**Acceptance Scenarios**:

1. **Given** `response_format=b64_json`, **Then** the response contains base64
   image data and no URL.
2. **Given** `n=2`, **Then** two images are returned or the unsupported value is
   rejected clearly.
3. **Given** a mask, **Then** it is uploaded and attached or the request is
   rejected with a documented limitation.

### Edge Cases

- Image is larger than the existing upload limit.
- Image contains EXIF orientation; output should not be unexpectedly rotated.
- Prompt is empty or only whitespace.
- Upstream returns an image URL that expires; download and re-host or document
  the TTL.
- Concurrent edits from the same account; account slot and rate limits apply.
- Image content policy rejection must map to a clear error, not a 500.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose `POST /v1/images/edits`.
- **FR-002**: The system MUST accept multipart form data with at least `image`
  and `prompt`.
- **FR-003**: The system MUST upload the input image through the existing Qwen
  OSS path and attach it to the edit request.
- **FR-004**: The system MUST return the OpenAI Images response shape with
  `url` or `b64_json` according to `response_format`.
- **FR-005**: The system MUST enforce the existing upload size and MIME limits.
- **FR-006**: The system MUST reuse account selection, quotas, cooldowns and
  metrics.
- **FR-007**: The system MUST sanitize and validate any remote image URL.
- **FR-008**: The system MUST map upstream content-policy errors to a 400/403
  with a stable error code.
- **FR-009**: The system MUST support at least PNG, JPEG and WebP input.
- **FR-010**: The endpoint MUST be documented in README and OpenAPI-like docs.

### Key Entities

- **ImageEditRequest**: image, mask, prompt, model, size, n, response format.
- **UploadedImage**: Qwen file id, URL, MIME, size, hash.
- **ImageEditResult**: image bytes or URL, revised prompt if available.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A valid PNG edit returns a decodable image in 100% of successful
  upstream responses.
- **SC-002**: Unsupported formats and oversized images are rejected before
  upstream work.
- **SC-003**: `response_format=b64_json` never returns a URL-only payload.
- **SC-004**: Existing image generation tests remain green.
- **SC-005**: Edit requests appear in metrics with their own operation label.

## Assumptions

- Qwen's image edit capability is reachable through the existing browser
  transport and OSS upload.
- Image generation and editing share account/quota policy.
- Streaming image edits are out of scope; the endpoint is request/response.
- A mask may not be supported upstream; the plan will confirm and document.
