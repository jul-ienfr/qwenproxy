# Feature Specification: Qwen Code CLI Endpoint

**Feature Branch**: `011-qwen-cli-endpoint`

**Created**: 2026-11-07

**Status**: Draft — conditional on Qwen Code quota availability

**Input**: Gap analysis vs `Rfym21/Qwen2API`: it exposes `/cli` models backed by
Qwen Code / Qwen CLI with 256k context and native `tools`. The current project
only uses the Qwen Web chat protocol.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Use CLI-backed models (Priority: P1)

A client selects a CLI model and receives 256k context with native tool calling,
separate from the web chat pool.

**Why this priority**: Native tools and larger context are materially better for
coding agents than prompt-engineered web tools.

**Independent Test**: Call `/v1/chat/completions` with a `/cli` model, send a
tool declaration, and verify a native tool call and a large-context request.

**Acceptance Scenarios**:

1. **Given** a valid Qwen Code credential, **When** a `/cli` model is requested,
   **Then** the request is routed to the CLI provider, not the web chat pool.
2. **Given** a tool declaration, **Then** the upstream receives native tools and
   the response maps to OpenAI `tool_calls`.
3. **Given** no valid CLI credential, **Then** the endpoint returns a clear
   capability/auth error and does not fall back silently to web chat.

---

### User Story 2 - Keep pools isolated (Priority: P1)

CLI accounts and web accounts have separate credentials, cooldowns and quotas.

**Why this priority**: CLI quotas and web quotas fail independently; mixing them
would mis-route requests and corrupt cooldown accounting.

**Independent Test**: Exhaust a CLI account and verify web accounts remain
selectable, and vice versa.

**Acceptance Scenarios**:

1. **Given** a CLI account on quota cooldown, **When** a web model is requested,
   **Then** web selection ignores the CLI cooldown.
2. **Given** a web account on WAF cooldown, **When** a CLI model is requested,
   **Then** CLI selection ignores the web cooldown.

---

### User Story 3 - Migrate or disable cleanly (Priority: P2)

The operator can disable the CLI endpoint when Qwen changes or removes the free
quota, without breaking the web proxy.

**Why this priority**: The Qwen Code free quota has already been unreliable and
was reported dead by another project; the feature must be optional.

**Independent Test**: Set the CLI feature flag to false and verify the endpoint
is absent or returns 404 while all web endpoints remain green.

**Acceptance Scenarios**:

1. **Given** CLI is disabled, **Then** `/v1/models` does not advertise CLI models.
2. **Given** a request to a CLI model while disabled, **Then** the response is a
   stable 404/400 capability error.
3. **Given** CLI credentials are removed, **Then** the web proxy starts normally.

### Edge Cases

- Qwen Code OAuth token expires; refresh failure must not crash the process.
- CLI and web accounts share an email but have different credentials; they must
  remain separate records.
- Native tool arguments may stream in fragments; the existing tool parser must
  not double-parse them.
- Context above the CLI limit must be rejected before upstream work.
- The CLI endpoint may be region-restricted; capability detection is required.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support a separate CLI provider configuration and
  credential store.
- **FR-002**: CLI models MUST be selectable through `/v1/models` and
  `/v1/chat/completions`.
- **FR-003**: CLI requests MUST use native tool declarations and map native tool
  calls to OpenAI/Anthropic shapes.
- **FR-004**: CLI and web account pools MUST have independent cooldowns, quotas
  and usage accounting.
- **FR-005**: A missing/expired CLI credential MUST produce a clear auth error,
  not an implicit web fallback.
- **FR-006**: CLI support MUST be disableable by configuration.
- **FR-007**: Context and output limits MUST be enforced per CLI model.
- **FR-008**: The feature MUST be documented as conditional on Qwen Code quota.
- **FR-009**: No web account credential may be sent to the CLI provider.
- **FR-010**: The feature MUST reuse the existing streaming and tool-call
  tests where possible.

### Key Entities

- **CliProvider**: base URL, auth method, token state, capability flags.
- **CliAccount**: credential, cooldown, quota, email, pool id.
- **CliModel**: id, context window, native tools, output limit.
- **PoolBinding**: request → web or CLI pool.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A CLI model request with a valid credential completes with native
  tool calling.
- **SC-002**: CLI quota exhaustion does not affect web account selection.
- **SC-003**: Disabling CLI leaves all existing web tests green.
- **SC-004**: A missing credential never silently falls back to web chat.
- **SC-005**: 256k-context requests are routed only when the model advertises
  that limit.

## Assumptions

- Qwen Code free quota may be unavailable; the feature is opt-in and can be
  removed without affecting the core proxy.
- CLI credentials are distinct from web account cookies/JWTs.
- The existing tool-call parser and streaming layer can be reused with a native
  provider adapter.
- The plan must include a live capability probe before advertising CLI models.
