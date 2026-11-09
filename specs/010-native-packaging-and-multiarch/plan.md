# Implementation Plan: Native Packaging and Multi-Arch Distribution

**Feature Branch**: `010-native-packaging-and-multiarch`

**Status**: Implemented

## Summary

Publish standalone Windows x64 and Linux x64/arm64 executables alongside the
existing npm package and Docker image, and make the multi-arch Docker path
explicit and verifiable. Bundling uses Bun's `--compile` mode; it embeds the
JavaScript application and the Bun runtime, while Patchright's Chromium remains
a separate (documented) browser dependency on native installs and is bundled in
the Docker image.

## Build metadata

`src/core/build-info.ts` becomes the single source of build/version metadata:

- Version: bundle-time `__QWENPROXY_VERSION__`, then `package.json`, then
  `0.0.0`.
- Commit: bundle-time `__QWENPROXY_COMMIT__`, then `QWENPROXY_BUILD_COMMIT` /
  `GIT_COMMIT` / `GITHUB_SHA`, then `git rev-parse --short=12 HEAD`, then
  `unknown`.
- Build date: bundle-time `__QWENPROXY_BUILD_DATE__`, then
  `QWENPROXY_BUILD_DATE`, then `SOURCE_DATE_EPOCH`, then the current time.
- Standalone flag: bundle-time `__QWENPROXY_STANDALONE__`.

`--version`/`-v` is handled directly by `src/index.ts` so the standalone binary
does not depend on `bin/qwenproxy.js`. `bin/qwenproxy.js` reads the same values
from `dist/build-meta.json` for npm installs.

## Standalone build

- `scripts/build-meta.mjs` collects metadata and produces esbuild/Bun defines.
- `scripts/build.mjs` replaces the raw esbuild CLI: same six entrypoints,
  injected metadata, and `dist/build-meta.json`.
- `scripts/build-standalone.mjs` runs `bun build --compile` for
  `win-x64`, `linux-x64`, and `linux-arm64`, with `proxy-agent` and
  `chromium-bidi` marked external (optional Patchright imports) and Bun's
  automatic `.env` loading disabled so the documented lookup order applies.
- `scripts/checksums.mjs` writes/verifies `SHA256SUMS` for release assets and is
  also used in tests.

## Runtime packaging behavior

- `resolveDataDir` recognizes `data/` next to the executable first (portable
  install), then the current-directory checkout, then the OS data directory.
  `QWEN_DATA_DIR` remains the highest-precedence override.
- `getEnvFilePath` checks the executable directory, then the current directory,
  then the data directory.
- Missing Chromium in a standalone build prints an actionable message (install
  Node and run `npx patchright install chromium`, use Docker, or point
  `PLAYWRIGHT_BROWSERS_PATH` at an existing install) instead of trying to spawn
  the proxy binary as a browser installer.
- `/health` (authenticated body) and the admin overview expose the version,
  commit, build date and runtime for release verification.

## CI/CD

Extend `.github/workflows/ci.yml` with:

- a `standalone` matrix job (Windows x64, Linux x64, Linux arm64) that downloads
  Bun, builds the binary, smoke-tests `--version` on host-compatible targets, and
  uploads artifacts;
- release-job steps that download every binary, generate the combined
  `SHA256SUMS`, attach both to the GitHub release, and include install/upgrade
  guidance in the generated notes;
- Docker build arguments/labels for version and revision, and a version tag for
  the multi-arch image.

## Documentation

- `docs/STANDALONE.md`: assets, checksum verification, data-directory and
  browser behavior, unsigned-binary trust model, macOS status, and the
  reproducible build command.
- README (EN/ES/PT-BR): download/install summary, checksum and `--version`
  verification, Docker multi-arch/volume note.
- `.env.example`: `QWEN_DATA_DIR`/`PLAYWRIGHT_BROWSERS_PATH` notes where missing.

## Verification

- Unit tests for build metadata, portable path resolution, and
  checksum write/verify.
- Script-level tests using a temporary directory (no release secrets needed).
- `npm run typecheck`, focused tests, full `npm run test:mock`, `npm run build`,
  and a local Windows standalone build whose `--version` output is checked from
  a directory without `node_modules`.
- Cross-compile Linux x64/arm64 with Bun and verify file type/size (execution of
  foreign architectures is left to CI).
