# Feature Specification: Runtime Model Mapping and Aliases

**Feature Branch**: `009-runtime-model-mapping`

**Created**: 2026-11-07

**Status**: Implemented

**Input**: Gap analysis vs `Rfym21/Qwen2API`: `MODEL_MAP` supports
`alias=qwen-id,...,*=fallback`, editable in the admin settings. The current
project has code-level model aliases but no operator-facing runtime mapping.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Map client model names to Qwen IDs (Priority: P1)

An operator maps client-facing names such as `gpt-4o` or `claude-sonnet` to
current Qwen model IDs without changing client configuration.

**Why this priority**: Coding agents hardcode model names; mapping avoids editing
every client when Qwen rotates models.

**Independent Test**: Set `gpt-4o=qwen3.8-max`, call `/v1/chat/completions` with
`gpt-4o`, and verify the upstream payload uses `qwen3.8-max`.

**Acceptance Scenarios**:

1. **Given** an exact alias, **When** a request uses it, **Then** the mapped Qwen
   ID is sent upstream.
2. **Given** a wildcard fallback, **When** an unknown model arrives, **Then** the
   fallback is used and the response reports the effective model.
3. **Given** an upstream-native Qwen ID, **Then** it passes through unchanged.

---

### User Story 2 - Edit mappings without restarting (Priority: P2)

An operator changes mappings from the admin API/dashboard and the next request
uses the new mapping.

**Why this priority**: Qwen model IDs change frequently; restarting the proxy is
disruptive.

**Independent Test**: Change an alias through the admin API and send a request
without restarting.

**Acceptance Scenarios**:

1. **Given** a saved mapping, **Then** `/v1/models` reflects the alias.
2. **Given** an invalid mapping (empty target, duplicate key), **Then** the save
   is rejected with a clear error.

---

### User Story 3 - Preserve explicit model capabilities (Priority: P3)

The mapped model keeps the target model's context window, reasoning and tool
capabilities.

**Why this priority**: An alias must not silently inherit the alias name's old
metadata.

**Independent Test**: Map a small model name to a 1M-context Qwen model and verify
context metadata and limits.

**Acceptance Scenarios**:

1. **Given** a mapped model, **Then** `/v1/models` reports the target's context
   and capabilities.
2. **Given** a mapping to an unknown target, **Then** the request fails with a
   clear model-not-found error.

### Edge Cases

- Alias chain (`a=b`, `b=c`) must be resolved once or rejected to avoid loops.
- Case sensitivity and whitespace.
- A client sends a model with a reasoning suffix (`-thinking`) plus an alias.
- Wildcard fallback must not mask typos for admin keys; it may be disabled.
- Model list caching must invalidate after a mapping change.
- Multiple mappings to the same target are allowed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST accept a configurable model mapping.
- **FR-002**: Mapping syntax MUST support exact aliases and a wildcard fallback.
- **FR-003**: Exact match MUST take precedence over wildcard; upstream IDs pass
  through.
- **FR-004**: Mapping MUST apply to OpenAI, Anthropic, Responses and (when
  added) Gemini routes.
- **FR-005**: `/v1/models` MUST expose aliases and the effective target
  capabilities.
- **FR-006**: Mapping changes MUST be possible without a process restart.
- **FR-007**: Invalid mappings MUST be rejected with actionable errors.
- **FR-008**: The effective model MUST be logged without leaking prompt content.
- **FR-009**: A mapping cycle MUST be detected and rejected.
- **FR-010**: The default behavior with no mapping MUST remain unchanged.

### Key Entities

- **ModelMapping**: alias, target, wildcard flag, updated timestamp.
- **ResolvedModel**: requested, effective Qwen id, capabilities, source of mapping.
- **MappingValidation**: valid, errors, warnings.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A client that sends `gpt-4o` reaches the configured Qwen model
  without client changes.
- **SC-002**: Unknown models use the wildcard only when configured.
- **SC-003**: Mapping changes take effect on the next request.
- **SC-004**: `/v1/models` context metadata matches the target model.
- **SC-005**: Existing tests without mapping remain green.

## Assumptions

- The existing `model-alias.ts` normalization remains the low-level resolver.
- Runtime mappings are stored in SQLite or the existing settings store.
- The web dashboard from spec 003 provides the editing UI; the admin API is the
  contract.
- Model mapping is operator-controlled, not user-controlled.
