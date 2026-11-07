# Feature Specification: Web Search and Citations

**Feature Branch**: `005-web-search-and-citations`

**Created**: 2026-11-07

**Status**: Draft

**Input**: Gap analysis vs `Rfym21/Qwen2API` (smart search) and
`encryptarun/qwen-api` (web search with clickable citations and OpenAI-compatible
annotations). The current project hardcodes `auto_search: false` in the Qwen
payload and exposes no search control.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Enable web search per request (Priority: P1)

A client asks for web search on a single request without changing global
configuration.

**Why this priority**: Search changes latency, cost and answer semantics; it
must be explicit and reproducible.

**Independent Test**: Send the same prompt once with search disabled and once
with search enabled; the enabled request includes search sources and the disabled
one does not.

**Acceptance Scenarios**:

1. **Given** a request with `web_search: true`, **When** the model answers,
   **Then** the Qwen payload has search enabled and the response carries source
   metadata.
2. **Given** a request without the field, **Then** the current default applies.
3. **Given** a model that does not support search, **When** search is requested,
   **Then** the request fails with a clear 400 or is downgraded with a warning
   header and log entry.

---

### User Story 2 - Return citations in OpenAI-compatible form (Priority: P1)

A client receives citations as structured annotations or a documented metadata
field, not as opaque text.

**Why this priority**: Without structured citations, downstream UIs cannot render
or verify sources.

**Independent Test**: Send a factual query with search enabled and validate the
returned citation URLs and titles.

**Acceptance Scenarios**:

1. **Given** a search answer with three sources, **Then** the response contains
   three annotations with `url`, `title` and `start_index`/`end_index` where
   available.
2. **Given** a source URL is unsafe or malformed, **Then** it is omitted and a
   warning is logged; the answer is still delivered.
3. **Given** streaming, **Then** citations arrive before the terminal chunk or in
   the final metadata event.

---

### User Story 3 - Search profiles and model variants (Priority: P2)

An operator exposes `-search` model variants or a `search` mode without changing
the base model catalog.

**Why this priority**: Clients that cannot send custom fields can still select a
search-capable model.

**Independent Test**: Select a `-search` model and confirm search is enabled.

**Acceptance Scenarios**:

1. **Given** a model ID ending in `-search`, **Then** search is enabled and the
   base model is sent upstream.
2. **Given** `SIMPLE_MODEL_MAP`-style filtering, **Then** search variants follow
   the configured catalog policy.

### Edge Cases

- Search enabled with a very large prompt; large-context externalization must
  preserve search mode.
- Search returns zero sources; the answer must still complete with an empty
  citation list.
- Upstream search times out; the request must fail with a retryable error or
  return a partial answer with a warning, not hang.
- Search on a model that silently ignores the flag; the response must expose
  whether search actually ran.
- Citations must not be duplicated when the model repeats a source.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST accept an opt-in search flag per request (body
  field, header or documented model suffix).
- **FR-002**: The system MUST set the Qwen search feature flags only when search
  is requested and the model supports it.
- **FR-003**: The system MUST expose search capability in `/v1/models`
  metadata.
- **FR-004**: The system MUST map upstream search results to OpenAI-compatible
  annotations or a documented `search_results` extension.
- **FR-005**: The system MUST validate and sanitize citation URLs.
- **FR-006**: The system MUST report whether search actually ran in a response
  header or metadata field.
- **FR-007**: Search MUST work in streaming and non-streaming modes.
- **FR-008**: Search MUST compose with tools, reasoning and large-context
  externalization.
- **FR-009**: Search-disabled requests MUST keep `auto_search: false`.
- **FR-010**: The system MUST log search enablement without logging query
  contents at info level.

### Key Entities

- **SearchRequest**: enabled, mode, requested sources, model.
- **SearchResult**: title, url, snippet, index.
- **CitationAnnotation**: url, title, start/end offsets.
- **SearchOutcome**: ran, skipped reason, source count.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A search-enabled request produces at least one structured citation
  when Qwen returns sources.
- **SC-002**: Search-disabled requests produce zero search calls.
- **SC-003**: Citation URLs pass the existing safe-URL validation in 100% of
  cases.
- **SC-004**: Streaming and non-streaming modes return equivalent citation sets.
- **SC-005**: Existing non-search tests remain unchanged.

## Assumptions

- Qwen's search is a feature flag on the existing chat request, not a separate
  API.
- Source metadata format may vary upstream; the adapter will normalize a stable
  subset.
- Search may be region- or account-dependent; unsupported accounts must degrade
  predictably.
- Search remains opt-in by default to preserve current behavior.
