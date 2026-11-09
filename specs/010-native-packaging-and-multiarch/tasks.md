# Tasks: Native Packaging and Multi-Arch Distribution

**Input**: `specs/010-native-packaging-and-multiarch/spec.md`

**Prerequisites**: plan.md

## Phase 1 - Build metadata

- [x] T001 Create `src/core/build-info.ts` with version, commit, build date,
      standalone flag, `getAppVersion()`, `getBuildMetadata()` and
      `formatVersionLine()`.
- [x] T002 Make `src/index.ts` handle `--version`/`-v`/`version` before creating
      data directories or starting the server.
- [x] T003 Update `bin/qwenproxy.js` to read `dist/build-meta.json` and include
      the commit when available.
- [x] T004 Update the admin overview and `/health` authenticated body to expose
      build metadata.

## Phase 2 - Standalone build pipeline

- [x] T005 Add `scripts/build-meta.mjs` with shared metadata collection and
      esbuild/Bun defines.
- [x] T006 Replace the raw esbuild CLI build with `scripts/build.mjs`; keep the
      six npm entrypoints and write `dist/build-meta.json`.
- [x] T007 Add `scripts/build-standalone.mjs` for Windows x64, Linux x64 and
      Linux arm64 Bun compiles.
- [x] T008 Add `scripts/checksums.mjs` with SHA256SUMS generation and
      verification.
- [x] T009 Add npm scripts for `build`, `build:standalone`, `checksums` and
      `verify:checksums`.

## Phase 3 - Runtime packaging behavior

- [x] T010 Prefer `data/` next to the executable in `resolveDataDir`, then the
      checkout, then the OS data directory (with `QWEN_DATA_DIR` still first).
- [x] T011 Resolve `.env` from the executable directory before the current
      directory and the data directory.
- [x] T012 Print an actionable missing-Chromium message in standalone builds
      instead of spawning the proxy binary as an installer.
- [x] T013 Add Docker build arguments/labels and a Dockerfile healthcheck; keep
      the non-root `gosu` runtime and the `/app/data` volume.

## Phase 4 - CI/CD

- [x] T014 Add a Bun-based standalone matrix job (Windows x64, Linux x64, Linux
      arm64) with host-compatible `--version` smoke tests and artifact upload.
- [x] T015 Download standalone artifacts in the release job, generate the
      combined `SHA256SUMS`, and attach binaries and checksums to the GitHub
      release.
- [x] T016 Add install/upgrade/breaking-change guidance to generated release
      notes and tag the multi-arch Docker image with the package version.

## Phase 5 - Documentation

- [x] T017 Add `docs/STANDALONE.md` covering assets, checksums, data/browser
      paths, unsigned binaries, macOS scope and reproducible builds.
- [x] T018 Update README (EN/ES/PT-BR) with standalone download, checksum,
      `--version`, data-directory and Docker multi-arch notes.
- [x] T019 Update `.env.example` for standalone data/browser variables.

## Phase 6 - Verification

- [x] T020 Add build-metadata, portable-path and checksum tests.
- [x] T021 Run `npm run typecheck`, focused tests, full `npm run test:mock`, and
      `npm run build`.
- [x] T022 Build a local Windows standalone binary and verify `--version` from a
      directory without `node_modules`; cross-compile Linux x64/arm64.
- [x] T023 Update spec status, backlog tables and commit/push to `origin/main`.
