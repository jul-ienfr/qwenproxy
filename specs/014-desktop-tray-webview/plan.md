# Implementation Plan: Desktop Tray Icon and Dashboard Webview

**Feature Branch**: `014-desktop-tray-webview`

**Status**: Implemented

## Summary

Add an optional desktop shell (`qpx gui` / `qpx --gui`) built on
`@webviewjs/webview` (Rust + Wry/WebView2). The shell owns a tray icon and one
native window that renders the existing dashboard. It spawns and supervises the
existing server entrypoint as a child process instead of loading the proxy and
Playwright into the GUI process.

No HTTP route, admin endpoint, authentication rule, or LAN binding changes.

## Architecture

```text
qpx gui
  └─ bin/qwenproxy.js
       └─ node dist/gui/main.js        (or tsx src/gui/main.ts)
            ├─ ServerManager
            │    ├─ GET /health (reuse or wait)
            │    └─ child: node dist/index.js (or tsx src/index.ts)
            └─ @webviewjs/webview
                 ├─ TrayIcon  (Open / Restart / Quit)
                 ├─ BrowserWindow (close -> hide)
                 └─ Webview -> http://127.0.0.1:<port>/admin
```

The server child stays a normal QwenProxy process: same `.env`, same data
directory, same browser profiles, same `HOST`/`PORT` semantics.

## Files

| File | Purpose |
| --- | --- |
| `src/gui/icon.ts` | Deterministic RGBA tray/window icon generation (no image assets). |
| `src/gui/server-manager.ts` | Resolve the server target, detect an existing server, spawn/poll/restart/stop the child, capture recent output. |
| `src/gui/dashboard-auth.ts` | Loopback-only dashboard auto-login: create a session with `API_KEY`/`QWEN_GUI_ADMIN_KEY` and inject the `qpx_admin` cookie. |
| `src/gui/main.ts` | GUI entrypoint: env/data bootstrap, lazy webview load, tray menu, window, webview navigation guard, auto-login, lifecycle cleanup. |
| `bin/qwenproxy.js` | Dispatch `gui` / `--gui`, `--port` normalization, help text, `--dry-run` dispatch check, Chromium preflight. |
| `scripts/build.mjs` | Add `src/gui/main.ts` to the esbuild entrypoints; keep the webview package external. |
| `package.json` | Add `@webviewjs/webview` as an optional dependency. |
| `src/tests/gui-icon.test.ts` | Icon buffer shape, transparency, color, and size checks. |
| `src/tests/gui-server-manager.test.ts` | Target resolution, reuse, spawn/poll, timeout, restart, stop, output capture. |
| `src/tests/gui-dashboard-auth.test.ts` | Auto-login request, loopback guard, cookie extraction/attributes, failure fallbacks. |
| `src/tests/cli.test.ts` | `gui` / `--gui` help and dispatch dry-run. |
| `docs/GUI.md` | User-facing install, usage, menu, troubleshooting. |
| `README*.md` | Short GUI section pointing at `docs/GUI.md`. |

## Server lifecycle

- **Resolve target**: wildcard `HOST` (`0.0.0.0`, `::`, `[::]`) maps to
  `127.0.0.1`; `localhost` stays as-is. The dashboard URL is
  `http://<host>:<port>/admin`.
- **Reuse**: perform one `/health` probe before spawning. Any 2xx/3xx response
  means an existing server is serving; record `ownsServer = false`.
- **Spawn**: prefer `dist/index.js` when present; otherwise use the same `tsx`
  loader resolution as `bin/qwenproxy.js` with `src/index.ts`. The child receives
  the current environment, so `PORT`, `HOST`, `API_KEY`, `QWEN_DATA_DIR` and all
  proxy settings are shared. Spawn with `windowsHide: true` and piped stdio so no
  extra console window appears.
- **Readiness**: poll `/health` every 250 ms for up to 60 s. Fail fast if the
  child exits; the rejection includes the last bounded stderr/stdout lines.
- **Restart**: stop the owned child, spawn again, and re-poll. Reuse an external
  server if it is still healthy.
- **Stop**: send `SIGTERM`, wait up to 5 s, then force-kill. Never signal a child
  the manager did not start.
- **Output capture**: keep a bounded ring buffer (last 40 lines) while streaming
  output to the parent console for terminal users.

## GUI lifecycle

- Bootstrap `ensureDataDirs()` and load `.env` exactly like `src/index.ts`, but
  never start Playwright in the GUI process.
- Parse `--port`/`--port=N` and apply it before importing the config module; the
  normalized value is inherited by the server child.
- Lazy-load `@webviewjs/webview` through a non-literal dynamic import so
  TypeScript and non-GUI builds do not require the optional native package.
- Verify Node >= 24 and print install hints for missing `@webviewjs/webview`.
- `app.whenReady()` → create tray, create window and webview, then load the
  dashboard.
- Tray: `menuOnRightClick: true`, `menuOnLeftClick: false`; left-click shows and
  focuses the window. Menu ids `open-dashboard`, `restart-server`, `quit`.
- Window `close` event calls `preventDefault()` and hides the window.
- `application-close-requested` is ignored while the tray is alive.
- Navigation guard allows only the dashboard origin (plus `about:blank`); all
  other navigations and new-window requests are cancelled.
- A dedicated `WebContext` rooted at `<data>/gui-webview` persists dashboard
  cookies across hide/show and restarts.
- After the server is ready and before loading `/admin`, auto-login POSTs to
  `/admin/api/session` with `QWEN_GUI_ADMIN_KEY || API_KEY`, extracts the
  `qpx_admin` cookie from `Set-Cookie`, and injects it with `view.setCookie()`.
  This only happens for loopback targets; failures log a generic reason and let
  the dashboard login form take over.
- On any failure, render a self-contained error page with the escaped message,
  the dashboard URL, and a hint to use **Restart server**.
- Cleanup runs once on Quit, `SIGINT`, `SIGTERM`, uncaught exceptions, and
  process exit: stop the owned child, dispose the app, exit.

## CLI

- `qpx gui`, `qpx --gui`, and `qpx gui --port 8123` dispatch to the GUI.
- `--port` is stripped from GUI args and exported as `PORT` so both the GUI and
  the child agree.
- `--dry-run` prints the selected source entrypoint and exits 0; it is used by
  the CLI dispatch test and is intentionally undocumented in `--help`.
- The GUI is added to the Chromium preflight list because the server child needs
  Patchright even though the GUI itself does not.

## Build and packaging

- `scripts/build.mjs` gains `src/gui/main.ts`; `packages: "external"` leaves the
  optional native package untouched.
- `@webviewjs/webview` is an `optionalDependencies` entry. A failed optional
  install does not break the CLI; `qpx gui` reports the missing package.
- Standalone binaries are unchanged and remain server-only. `docs/GUI.md`
  documents this boundary.

## Testing

- Unit tests inject `spawn`, `fetch`, `sleep`, and clock functions into
  `ServerManager`; no real server or native package is required.
- Icon tests assert dimensions, RGBA length, transparent corners, opaque center,
  and that both 16 px and 32 px render.
- CLI tests assert `--help` mentions `gui`/`--gui` and `gui --dry-run` selects the
  GUI source entrypoint without launching anything.
- Manual Windows smoke: `qpx gui`, tray left/right click, close-to-tray,
  Restart server, Quit, and `HOST=0.0.0.0` URL mapping.

## Verification

- `npm run typecheck` passes; focused GUI/CLI tests pass 30/30.
- Full `npm run test:mock` passes 1037/1037.
- Auto-login against a live server created a `qpx_admin` session and built the
  expected cookie attributes; the API key is never sent to a remote host.
- `npm run build` emits `dist/gui/main.js` and keeps
  `@webviewjs/webview` external.
- Windows smoke with a local stub server: the GUI created the tray/window,
  reused the healthy server, and the WebView2 view loaded `/admin`.
  Interactive tray actions (click, close-to-tray, Restart, Quit) remain a
  manual check.

## Risks

- **Optional native package**: WebView2 runtime may be absent on old Windows.
  The error page points at the Microsoft WebView2 runtime installer.
- **Node version**: the package requires Node 24+; the GUI fails clearly instead
  of crashing on older runtimes.
- **Child stdout**: piped output forwarders must use bounded buffers so a chatty
  server cannot grow GUI memory.
- **Duplicate instances**: the reuse probe prevents a second server, but a
  server that is starting (not yet healthy) can race a GUI launch. The port
  preflight in `startServer` still turns that into an explicit error.
