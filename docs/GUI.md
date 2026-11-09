# Desktop GUI (Tray + Dashboard Webview)

`qpx gui` starts QwenProxy and opens the existing web dashboard in a native
window. A tray icon stays in the Windows notification area, next to the clock,
so the dashboard can be reopened without a browser tab or a terminal.

The GUI is a thin desktop shell: it spawns the normal server entrypoint as a
child process and renders `http://127.0.0.1:<port>/admin`. It does not change
the HTTP API, authentication, request routing, search defaults or browser
profiles.

## Requirements

- **Node.js 24 or newer** (the GUI process itself; the server still works on
  Node 22+).
- **`@webviewjs/webview`**, installed as an optional dependency by npm. If your
  package manager skipped optional dependencies:
  ```bash
  npm install @webviewjs/webview
  ```
- **Windows 10/11** with the Microsoft Edge WebView2 runtime (preinstalled on
  current Windows releases). macOS and Linux desktop sessions are supported by
  the underlying library; Windows is the primary target.
- The same `.env`, Qwen accounts and Chromium/Patchright install as the normal
  server.

## Usage

```bash
qpx gui
qpx --gui
qpx gui --port 8123
```

`--port` is applied to both the GUI URL and the server child.

On startup the GUI:

1. resolves the configured `HOST`/`PORT`, mapping `0.0.0.0`/`::` to
   `127.0.0.1` for its own window;
2. probes `/health` and reuses a server that is already running;
3. otherwise starts `dist/index.js` (or `src/index.ts` through `tsx`) and waits
   for `/health` for up to 60 seconds;
4. creates the tray icon and opens the dashboard.

## Tray menu

| Action | Behavior |
| --- | --- |
| **Open dashboard** | Shows and focuses the window (left-click does the same). |
| **Restart server** | Stops the child the GUI owns, starts it again, reloads the dashboard. An external server is reused when still healthy. |
| **Quit** | Stops the owned server child, removes the tray icon and exits. A server the GUI did not start is left running. |

Closing the window hides it to the tray. The proxy keeps serving.

## Authentication and LAN access

The GUI is a local client, not a bypass:

- On a loopback target, the GUI signs in automatically: it creates a dashboard
  session through `POST /admin/api/session` with `API_KEY` (or the
  `QWEN_GUI_ADMIN_KEY` override) and injects the returned `qpx_admin` cookie
  into the webview before loading `/admin`. The audit log records
  `session.login`.
- If auto-login fails (wrong key, session endpoint unavailable), the normal
  dashboard login form is shown instead. The failure reason is logged without
  the key.
- The API key is never sent to a non-loopback target. A remote `HOST` keeps the
  normal login form, so the operator credential stays off the network.
- `QWEN_GUI_ADMIN_KEY` is only needed when the GUI must use a different admin
  key than its own `.env` (for example an external server started with another
  `API_KEY`, or a runtime-generated key).
- The dashboard session cookie is stored in `<data>/gui-webview`, so hiding the
  window or restarting the GUI does not log you out.
- `HOST=0.0.0.0` still binds the server for LAN clients; only the GUI's own URL
  uses `127.0.0.1`.
- Navigation is restricted to the dashboard origin. Foreign links and
  `window.open` requests are cancelled.

The tray menu is a local desktop control; it does not expose a new network
surface.

## Data and logs

- The GUI process only manages a child; server logs keep going to the normal
  server log and to the console that launched `qpx gui`.
- The server child is spawned hidden (`windowsHide`), so launching the GUI from
  Explorer or autostart never flashes a second console window. The child's
  stdout/stderr are piped; nothing opens unless the user starts an interactive
  command.
- WebView2 data lives in `<data>/gui-webview`.
- `QWEN_DATA_DIR` and portable `data/` lookup behave exactly as for `qpx start`.

## Standalone binaries and Docker

Standalone binaries (`qwenproxy-windows-x64.exe`, …) are server-only and do not
bundle the GUI or its native webview package. Use the npm install for the
desktop GUI:

```bash
npm install -g qwenproxy-cli
qpx gui
```

Docker has no desktop session; keep using the dashboard in a browser or the TUI
locally.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `The desktop GUI needs the optional package @webviewjs/webview` | `npm install @webviewjs/webview` in the same environment as `qpx`. |
| `requires Node.js 24+` | Upgrade Node, or use `qpx start` / the TUI / Docker. |
| Blank window on Windows | Install the Microsoft Edge WebView2 runtime, then restart the GUI. |
| `QwenProxy could not start` with `No Qwen accounts configured` | Add an account with `qpx` or `qpx login`, then choose **Restart server**. |
| Port already in use | Stop the stale process (`netstat -ano | findstr :7936`) or run with another `--port`. |
| Window closed but proxy still running | Expected: this is close-to-tray. Use **Quit** to stop the child. |
| Tray icon missing | Check the Windows notification-area overflow panel; Windows may hide new icons by default. |

## Manual smoke test

1. `qpx gui` on Windows.
2. Confirm the tray icon appears and the dashboard renders.
3. Close the window; confirm `/health` still answers and the icon remains.
4. Left-click the icon; the window returns.
5. Right-click → **Restart server**; the dashboard reloads.
6. Right-click → **Quit**; the tray icon disappears and no `qwenproxy` child is
   left in Task Manager.
