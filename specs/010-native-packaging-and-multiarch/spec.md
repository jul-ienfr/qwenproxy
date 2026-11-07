# Feature Specification: Native Packaging and Multi-Arch Distribution

**Feature Branch**: `010-native-packaging-and-multiarch`

**Created**: 2026-11-07

**Status**: Draft

**Input**: Gap analysis vs `Rfym21/Qwen2API`: it publishes Windows x64 and Linux
x64/arm64 native binaries plus multi-arch Docker images. The current project
distributes npm and a Docker image but no standalone binary.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run without Node.js (Priority: P1)

A user downloads a Windows or Linux executable, supplies a `.env`, and starts the
proxy without installing Node.js or npm dependencies.

**Why this priority**: Native packaging removes the most common install failure
and makes the proxy usable on clean machines.

**Independent Test**: On a clean Windows VM, run the binary, open `/health`, and
complete one chat request.

**Acceptance Scenarios**:

1. **Given** a Windows x64 binary, **When** it starts, **Then** it reads `.env`,
   creates its data directory and serves `/health`.
2. **Given** a Linux x64 binary, **Then** the same behavior holds without a Node
   runtime.
3. **Given** a missing browser, **Then** the binary reports an actionable error
   and the install command.

---

### User Story 2 - Pull the right Docker architecture (Priority: P1)

A user on ARM64 (Raspberry Pi, Apple Silicon) pulls the image and gets a native
image without emulation.

**Why this priority**: Multi-arch images are expected for self-hosted software
and avoid slow or broken emulation.

**Independent Test**: `docker pull` on linux/amd64 and linux/arm64 and run
`/health` on both.

**Acceptance Scenarios**:

1. **Given** an ARM64 host, **When** the image is pulled, **Then** the manifest
   selects the arm64 layer.
2. **Given** an amd64 host, **Then** the amd64 layer is selected.
3. **Given** a browser dependency, **Then** the image includes the required
   Patchright/Chromium runtime or documents the install step.

---

### User Story 3 - Verify and update safely (Priority: P2)

A user can verify a checksum and see the version/build commit before running a
binary.

**Why this priority**: Standalone binaries are harder to audit than source; a
checksum and version stamp are minimum trust signals.

**Independent Test**: Compare the published SHA256 with the downloaded file and
run `--version`.

**Acceptance Scenarios**:

1. **Given** a release asset, **Then** a `SHA256SUMS` file lists every binary.
2. **Given** `--version`, **Then** the output includes the semantic version and
   build commit.
3. **Given** an update, **Then** the release notes link to the changelog.

### Edge Cases

- Windows Defender/SmartScreen reputation for unsigned binaries.
- macOS is not currently supported; the spec must state it or include signing.
- The binary must resolve its data directory relative to the executable or a
  documented env var.
- Docker image must not run as root if the current image already avoids it.
- Browser cache and profiles must persist in a mounted volume.
- The binary must not bundle `.env` or credentials.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The project MUST publish a Windows x64 standalone binary.
- **FR-002**: The project MUST publish Linux x64 and arm64 standalone binaries.
- **FR-003**: The project MUST publish multi-arch Docker images for amd64 and
  arm64.
- **FR-004**: Every binary MUST expose `--version` with version and commit.
- **FR-005**: Every release MUST publish SHA256 checksums.
- **FR-006**: The binary MUST read `.env`, create data directories and locate
  browser assets predictably.
- **FR-007**: The Docker image MUST include or install the browser runtime and
  document persistence volumes.
- **FR-008**: Packaging MUST NOT embed secrets, `.env`, account databases or
  browser profiles.
- **FR-009**: Release notes MUST identify breaking changes and migration steps.
- **FR-010**: The build MUST be reproducible from a tagged commit.

### Key Entities

- **ReleaseArtifact**: platform, architecture, filename, checksum, version.
- **BuildMetadata**: commit, date, Node/Bun version, browser version.
- **InstallProfile**: binary or Docker, data directory, browser path.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A clean Windows machine can run the proxy without Node.js.
- **SC-002**: ARM64 and amd64 Docker images both pass `/health`.
- **SC-003**: 100% of release assets have a matching checksum.
- **SC-004**: `--version` matches the release tag.
- **SC-005**: Existing npm and Docker install paths remain supported.

## Assumptions

- The current runtime can be bundled with a Node/Bun compiler; the plan will
  select the tool.
- Browser binaries remain a separate install on Windows/Linux, as they are today.
- Code signing is desirable but may be deferred; the spec must state the trust
  model.
- macOS support is out of scope unless signing/notarization is funded.
