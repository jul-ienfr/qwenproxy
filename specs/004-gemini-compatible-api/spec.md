# Feature Specification: Gemini-Compatible API

**Feature Branch**: `004-gemini-compatible-api`

**Created**: 2026-11-07

**Status**: Draft

**Input**: Gap analysis vs `YuJunZhiXue/qwen2API` and `123hi123/qwen2api-rs`:
both expose Gemini `generateContent` / `streamGenerateContent` alongside OpenAI
and Anthropic. The current project exposes OpenAI, OpenAI Responses, Anthropic
and legacy Completions, but not Gemini.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Use Gemini clients (Priority: P1)

A client that speaks the Gemini REST API can call Qwen models through this proxy
without an adapter.

**Why this priority**: Gemini compatibility is a clear differentiator and a
low-risk translation layer over the existing chat pipeline.

**Independent Test**: Send a Gemini `generateContent` request with a text prompt
and verify a valid Gemini response with the same text semantics as the OpenAI
endpoint.

**Acceptance Scenarios**:

1. **Given** `POST /v1beta/models/qwen3.8-max:generateContent` with a text
   prompt, **When** the upstream succeeds, **Then** the response contains
   `candidates[0].content.parts[].text` and `usageMetadata`.
2. **Given** the same request to `:streamGenerateContent`, **Then** the response
   is a valid Gemini SSE stream with incremental parts.
3. **Given** an invalid model, **Then** the error uses the Gemini error envelope
   with a 404/400 status, not the OpenAI envelope.

---

### User Story 2 - Preserve model and system semantics (Priority: P1)

A client can pass a Gemini system instruction, temperature, max output tokens
and safety settings without silently losing critical fields.

**Why this priority**: Silent field loss makes the adapter look compatible while
producing wrong behavior.

**Independent Test**: Send a request with system instruction, temperature and
max tokens; inspect the upstream payload and the response metadata.

**Acceptance Scenarios**:

1. **Given** a system instruction, **When** translated, **Then** it is delivered
   through the existing personalization path or an equivalent system role.
2. **Given** `maxOutputTokens`, **Then** the upstream output budget is bounded
   accordingly.
3. **Given** unsupported safety settings, **Then** the response includes a
   warning header or a documented ignored-field log, not a silent drop.

---

### User Story 3 - Tool calling compatibility (Priority: P2)

A Gemini client can declare function declarations and receive functionCall
parts.

**Why this priority**: Tool calling is required by agentic Gemini clients but is
a larger translation surface than plain text.

**Independent Test**: Declare one function, send a prompt that triggers it, and
verify a `functionCall` part with parsed arguments.

**Acceptance Scenarios**:

1. **Given** a function declaration, **When** the model emits a tool call, **Then**
   the response contains `functionCall.name` and `functionCall.args`.
2. **Given** a malformed tool call from upstream, **Then** the existing repair
   path is used and the failure is logged without corrupting the stream.

### Edge Cases

- Gemini uses `contents` with `role: "model"`; the translation must map it to
  assistant without losing multi-turn order.
- `inlineData` images must reuse the existing upload path.
- Empty candidates, blocked prompts and safety responses need explicit mapping.
- Streaming must emit a terminal event exactly once.
- A client may send `model` in the URL and a different model in the body; the URL
  wins or the conflict is rejected.
- Gemini API key header `x-goog-api-key` must be accepted in addition to Bearer.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose
  `POST /v1beta/models/{model}:generateContent`.
- **FR-002**: The system MUST expose
  `POST /v1beta/models/{model}:streamGenerateContent` with SSE.
- **FR-003**: The system MUST translate Gemini `contents`, `systemInstruction`,
  `generationConfig` and `tools` into the internal chat request.
- **FR-004**: The system MUST translate the internal response into Gemini
  `candidates`, `content.parts`, `finishReason` and `usageMetadata`.
- **FR-005**: The system MUST support `x-goog-api-key` and Bearer authentication.
- **FR-006**: The system MUST return Gemini-shaped errors for Gemini routes.
- **FR-007**: The system MUST preserve existing OpenAI/Anthropic/Responses
  behavior and tests.
- **FR-008**: Unsupported Gemini fields MUST be reported in a response header or
  structured log, not silently discarded.
- **FR-009**: Tool/function declarations MUST map to the existing tool
  instruction system; functionCall responses MUST map back to Gemini parts.
- **FR-010**: Multimodal `inlineData` and `fileData` MUST reuse the existing
  upload pipeline where possible.

### Key Entities

- **GeminiRequest**: model, contents, system instruction, generation config,
  tools, safety settings.
- **GeminiCandidate**: content parts, finish reason, safety ratings.
- **GeminiUsage**: prompt, candidate and total token counts.
- **TranslationWarning**: field, reason, action taken.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A standard Gemini SDK text request succeeds without client-side
  changes.
- **SC-002**: Streaming produces the same visible text as the non-streaming
  response for the same prompt.
- **SC-003**: Existing OpenAI and Anthropic contract tests remain green.
- **SC-004**: Unsupported fields are observable in 100% of cases where they
  would change behavior.
- **SC-005**: Tool-call round trips succeed for at least one declared function.

## Assumptions

- Gemini compatibility targets the REST `generateContent` surface, not Vertex AI
  proprietary features.
- Safety settings are approximated; Qwen does not expose identical controls.
- The existing internal chat model remains the single execution path.
- Gemini-specific model names may be aliased to Qwen model IDs by configuration.
