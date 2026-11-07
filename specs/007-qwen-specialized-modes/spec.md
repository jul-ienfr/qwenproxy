# Feature Specification: Qwen Specialized Modes

**Feature Branch**: `007-qwen-specialized-modes`

**Created**: 2026-11-07

**Status**: Draft

**Input**: Gap analysis vs `encryptarun/qwen-api`: it exposes Deep Research,
Web Dev, Full-Stack and Slides as first-class models/endpoints. The current
project exposes chat, tools, images and videos, but not these Qwen web modes.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run a deep research task (Priority: P1)

A client selects a research model, submits a question, and receives a report
with citations and downloadable artifacts.

**Why this priority**: Deep Research is the highest-value specialized mode and
maps to an existing Qwen web capability.

**Independent Test**: Submit a narrow research question, poll the task, and
verify a completed report with at least one citation.

**Acceptance Scenarios**:

1. **Given** `model=qwen-deep-research`, **When** the task completes, **Then**
   the response contains a report, citations and a task status.
2. **Given** the task is still running, **Then** the status endpoint returns
   `pending`/`running` with progress.
3. **Given** the upstream fails, **Then** the task ends `failed` with a stable
   error code.

---

### User Story 2 - Generate a web artifact (Priority: P2)

A client asks for a web component or page and receives generated code/artifacts
that can be previewed or downloaded.

**Why this priority**: Web Dev and Full-Stack are useful but broader and more
fragile than research.

**Independent Test**: Request a small static page and verify the returned files
or preview URL are complete and non-empty.

**Acceptance Scenarios**:

1. **Given** `model=qwen-web-dev`, **When** generation completes, **Then** the
   response includes the generated HTML/CSS/JS artifacts.
2. **Given** `model=qwen-full-stack`, **Then** the response identifies frontend
   and backend artifacts separately.

---

### User Story 3 - Generate slides (Priority: P3)

A client requests a slide deck and receives preview images and a downloadable
PDF or source file.

**Why this priority**: Slides is a niche output but demonstrates the specialized
mode framework.

**Independent Test**: Request a three-slide deck and verify the preview count and
download link.

**Acceptance Scenarios**:

1. **Given** `model=qwen-slides`, **Then** the response includes slide previews
   and a downloadable artifact.
2. **Given** the task is async, **Then** the same task status contract applies.

### Edge Cases

- Long-running tasks exceed the normal chat timeout; task state must survive a
  client disconnect.
- Artifact URLs expire; the proxy must download and re-host or document the TTL.
- Upstream mode is unavailable for an account; fail with a clear capability
  error.
- A task is cancelled by the client; upstream work should stop where possible.
- Research citations include unsafe URLs; they must be validated.
- Generated code may contain secrets or unsafe HTML; no automatic execution.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose dedicated model IDs for Deep Research,
  Web Dev, Full-Stack and Slides.
- **FR-002**: The system MUST map each model ID to the correct Qwen chat type and
  feature configuration.
- **FR-003**: Long-running modes MUST use an asynchronous task contract with
  status, progress and result retrieval.
- **FR-004**: Task state MUST survive client disconnects and be retrievable by
  task id.
- **FR-005**: Research results MUST include citations with validated URLs.
- **FR-006**: Artifacts MUST be returned as stable URLs or downloaded bytes, not
  ephemeral upstream links that expire immediately.
- **FR-007**: The system MUST reuse account selection, quotas, cooldowns and
  metrics.
- **FR-008**: Unsupported modes MUST fail with a capability error, not a generic
  500.
- **FR-009**: Generated artifacts MUST NOT be executed by the proxy.
- **FR-010**: The `/v1/models` catalog MUST advertise each mode and its
  capabilities.

### Key Entities

- **SpecializedTask**: id, mode, status, progress, created/updated, account.
- **ResearchReport**: markdown/text, citations, attachments.
- **WebArtifact**: files, preview URL, entry point.
- **SlideDeck**: slides, preview images, downloadable file.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A deep research task can be started, polled and completed without
  holding an HTTP connection open.
- **SC-002**: Completed artifacts remain retrievable for the documented TTL.
- **SC-003**: Citations pass URL validation in 100% of returned reports.
- **SC-004**: Unsupported modes return a stable capability error.
- **SC-005**: Existing chat/image/video endpoints are unaffected.

## Assumptions

- Qwen exposes these modes through the same authenticated web session.
- The modes are account- and region-dependent; capability detection is required.
- Async task storage can start in SQLite; Redis is optional later.
- The first release may ship Deep Research only, with the other modes behind the
  same contract.
