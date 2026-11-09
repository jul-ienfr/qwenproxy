# Standalone Binaries

QwenProxy ships self-contained executables for Windows x64 and Linux x64/arm64.
The Bun `--compile` pipeline embeds the application and the Bun runtime, so the
target machine does not need Node.js or `npm install`.

## Release assets

| Platform | Architecture | Asset |
| --- | --- | --- |
| Windows | x64 | `qwenproxy-windows-x64.exe` |
| Linux | x64 | `qwenproxy-linux-x64` |
| Linux | arm64 | `qwenproxy-linux-arm64` |

Every release also publishes `SHA256SUMS` and a `build-meta.json` file inside
the standalone build directory.

## Verify and run

```bash
# Linux / macOS shell
sha256sum -c SHA256SUMS
chmod +x qwenproxy-linux-x64
./qwenproxy-linux-x64 --version
```

```powershell
# Windows PowerShell
Get-FileHash .\qwenproxy-windows-x64.exe -Algorithm SHA256
.\qwenproxy-windows-x64.exe --version
```

`--version` prints the semantic version, the build commit and, for standalone
builds, the target platform/architecture:

```text
QwenProxy v1.6.11 (commit 094480f12345, built 2026-11-08T12:00:00.000Z, win32-x64)
```

## Data directory and `.env`

The lookup order is intentionally predictable for portable installs:

1. `QWEN_DATA_DIR` (highest precedence).
2. `data/` next to the executable (portable install).
3. `./data` in the current working directory (source checkout).
4. The OS user data directory:
   - Windows: `%APPDATA%\qwenproxy`
   - Linux/BSD: `$XDG_DATA_HOME/qwenproxy` or `~/.local/share/qwenproxy`
   - macOS: `~/Library/Application Support/qwenproxy`

`.env` is resolved from the executable directory first, then the current
directory, then the data directory. Put the binary and its `.env`/`data` folder
together to make the install fully portable.

Standalone packaging never embeds `.env`, account databases, encryption keys or
browser profiles.

## Chromium is not bundled

The standalone binary is intentionally browser-less. When Chromium is missing,
QwenProxy prints an actionable message instead of trying to install anything
silently. Choose one of:

1. Install Node.js and run `npx patchright install chromium`.
2. Use the Docker image, which bundles Chromium for the container architecture.
3. Point `PLAYWRIGHT_BROWSERS_PATH` at an existing Playwright/Patchright browser
   cache.

```bash
# Linux example
export PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright"
```

## Docker and multi-arch

The Docker image remains the fully self-contained option and is published for
`linux/amd64` and `linux/arm64`:

```bash
docker pull johngbl/qwenproxy:latest
docker run --rm -p 7936:7936 -v "$PWD/data:/app/data" --env-file .env \
  johngbl/qwenproxy:latest
```

Persist `/app/data` (SQLite database, encryption key, profiles and logs). The
image includes Chromium and runs as the non-root `pwuser` via `gosu`. Images are
tagged with `latest`, the commit SHA and the package version.

## Trust model

The binaries are not code-signed. Windows SmartScreen and some endpoint
protection tools may warn about a new, unsigned executable.

- Verify `SHA256SUMS` before running a downloaded binary.
- Check `--version` against the release tag and commit.
- If your policy requires provenance, build from the tagged source instead of
  trusting a download.

macOS binaries are out of scope until signing and notarization are available.

## Reproducible builds

Build the same artifacts locally from a tagged checkout:

```bash
npm ci
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) \
QWENPROXY_BUILD_COMMIT=$(git rev-parse --short=12 HEAD) \
node scripts/build-standalone.mjs --all
node scripts/checksums.mjs dist/standalone
node scripts/checksums.mjs dist/standalone --verify
```

`SOURCE_DATE_EPOCH` and `QWENPROXY_BUILD_COMMIT` make the injected metadata
deterministic. Bun itself may still produce platform-specific bytes; compare the
published checksums for the release you downloaded.

The standalone script uses Bun targets `bun-windows-x64`, `bun-linux-x64` and
`bun-linux-arm64`, keeps the optional `proxy-agent`/`chromium-bidi` imports
external, and disables Bun's automatic `.env`/`bunfig` loading so the documented
lookup order applies.

## Troubleshooting

- **`--version` fails on Linux**: make the file executable with `chmod +x`.
- **Chromium not found**: follow the browser section above.
- **Data appears in `%APPDATA%` instead of the install folder**: create a `data`
  directory next to the executable, or set `QWEN_DATA_DIR`.
- **Checksum mismatch**: re-download the asset; do not run it if the mismatch
  persists.
- **Windows Defender/SmartScreen warning**: verify the checksum, then allow the
  file through your organization's policy if you trust the release.
