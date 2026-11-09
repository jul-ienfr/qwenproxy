# Feature Specification: OpenAPI Contract and API Documentation

**Feature Branch**: `012-openapi-contract-and-docs`

**Created**: 2026-11-07

**Status**: Implemented

**Input**: Gap analysis vs `encryptarun/qwen-api` (OpenAPI 3.1 `qwen.json`,
hosted docs, examples) and `Rfym21/Qwen2API` (documented API surface). The
current project documents endpoints in README prose but has no machine-readable
contract.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Generate a client from the contract (Priority: P1)

A developer downloads the OpenAPI document and generates a typed client for the
proxy without reading the source.

**Why this priority**: Every protocol surface added by specs 004–011 multiplies
the cost of stale prose documentation; a contract is the scalable source of
truth.

**Independent Test**: Fetch `/openapi.json`, validate it with an OpenAPI 3.1
validator, and generate a client; call `/v1/models` with the generated client.

**Acceptance Scenarios**:

1. **Given** a running proxy, **When** `/openapi.json` is fetched, **Then** it is
   valid OpenAPI 3.1 and lists every public endpoint.
2. **Given** the generated client, **When** it calls `/v1/models` and
   `/v1/chat/completions`, **Then** the requests and responses match the schemas.
3. **Given** a new endpoint, **Then** the contract test fails until the
   document is updated.

---

### User Story 2 - Read interactive documentation (Priority: P2)

A developer opens `/docs` and sees endpoint descriptions, auth, request/response
examples and error envelopes.

**Why this priority**: README prose is not searchable by endpoint or schema.

**Independent Test**: Open `/docs`, authorize with the admin key, and execute a
`/v1/models` request from the page.

**Acceptance Scenarios**:

1. **Given** `/docs`, **Then** the page loads without external CDN dependencies
   or with a documented offline fallback.
2. **Given** an authenticated request from the docs page, **Then** the API key is
   not persisted in the URL or localStorage.
3. **Given** an endpoint with streaming, **Then** the documentation explains the
   SSE shape and terminal event.

---

### User Story 3 - Keep examples honest (Priority: P3)

The contract includes realistic examples for OpenAI, Anthropic, Responses and
Gemini routes, and the test suite verifies that examples parse against their
schemas.

**Why this priority**: Broken examples are worse than no examples.

**Independent Test**: Run the contract test and verify every example validates
against its schema.

**Acceptance Scenarios**:

1. **Given** an example in the contract, **When** the contract test runs, **Then**
   the example validates.
2. **Given** an endpoint change, **Then** the example and schema change together.

### Edge Cases

- Admin-only endpoints must not be exposed with the normal key scope.
- The contract must not include secrets or production hostnames.
- Streaming responses cannot be fully represented as a single JSON schema;
  document the event union and terminal marker.
- File upload endpoints use multipart, not JSON.
- Error envelopes differ between OpenAI, Anthropic and Gemini routes; document
  each.
- The contract must remain usable when the proxy has no accounts configured.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST publish an OpenAPI 3.1 document at
  `/openapi.json`.
- **FR-002**: The document MUST cover every public endpoint, including auth,
  request bodies, response schemas, errors and content types.
- **FR-003**: The system MUST serve interactive documentation at `/docs` or an
  equivalent static page.
- **FR-004**: A contract test MUST validate the document and its examples.
- **FR-005**: Adding or changing an endpoint without updating the contract MUST
  fail CI.
- **FR-006**: The document MUST describe OpenAI, Anthropic, Responses and Gemini
  error envelopes.
- **FR-007**: The document MUST NOT contain secrets, tokens, account emails or
  production hostnames.
- **FR-008**: The docs page MUST support Bearer authentication without
  persisting the key in localStorage.
- **FR-009**: The contract MUST be available offline in the repository.
- **FR-010**: The README MUST link to the contract and docs page.

### Key Entities

- **OpenApiDocument**: paths, components, security schemes, examples.
- **ContractCheck**: validator result, missing paths, invalid examples.
- **DocPage**: rendered documentation, auth state, endpoint search.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A generated client can call `/v1/models` and one chat endpoint
  without manual fixes.
- **SC-002**: 100% of public routes appear in the contract.
- **SC-003**: Contract validation passes in CI.
- **SC-004**: No secret or account identifier appears in the contract.
- **SC-005**: The docs page remains usable without internet access.

## Assumptions

- The existing Hono route definitions can expose enough metadata or be mirrored
  by a maintained document.
- Streaming is documented as an event contract rather than a single JSON schema.
- The docs page may use a bundled static viewer; no external service is
  required.
- This is a developer-experience feature and does not change runtime behavior.
