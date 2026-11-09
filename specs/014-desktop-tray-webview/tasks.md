# Tasks: Desktop Tray Icon and Dashboard Webview

**Input**: `specs/014-desktop-tray-webview/spec.md`

**Prerequisites**: plan.md

## Phase 1 - Specification

- [x] T001 Create `specs/014-desktop-tray-webview/spec.md` with user scenarios,
      acceptance criteria and success measures.
- [x] T002 Create `plan.md` describing the tray/webview/server-child
      architecture and lifecycle.
- [x] T003 Create `tasks.md` and register spec 014 in `specs/README.md`.

## Phase 2 - Icon and server supervision

- [x] T004 Add `src/gui/icon.ts` with deterministic RGBA icon generation and no
      image assets.
- [x] T005 Add `src/gui/server-manager.ts` with dashboard/health URL resolution
      (wildcard host -> `127.0.0.1`).
- [x] T006 Implement server reuse detection, child spawn, bounded output
      capture, `/health` polling, fast failure on child exit, restart and
      graceful stop.
- [x] T007 Resolve the server child entrypoint (`dist/index.js` first, then the
      `tsx` loader with `src/index.ts`).

## Phase 3 - GUI shell

- [x] T008 Add `src/gui/main.ts` with `.env`/data bootstrap, `--port`
      normalization and lazy `@webviewjs/webview` loading.
- [x] T009 Create the tray icon/menu: Open dashboard, Restart server, Quit;
      left-click shows and focuses the window.
- [x] T010 Create the dashboard window and webview with a persistent
      `<data>/gui-webview` context; close hides to tray.
- [x] T011 Restrict navigation to the dashboard origin and cancel new windows.
- [x] T012 Render an escaped error page with the captured server output and a
      restart hint when startup fails.
- [x] T013 Clean up the owned child and GUI resources on Quit, signals,
      exceptions and process exit.

## Phase 4 - CLI and build wiring

- [x] T014 Dispatch `gui` and `--gui` in `bin/qwenproxy.js`; add help entries.
- [x] T015 Normalize `--port`/`--port=N` into `PORT` for both GUI and child.
- [x] T016 Add a `--dry-run` dispatch path for tests.
- [x] T017 Add `gui` to the Chromium preflight command list.
- [x] T018 Add `src/gui/main.ts` to `scripts/build.mjs` entrypoints.
- [x] T019 Add `@webviewjs/webview` as an optional dependency and refresh the
      lockfile.

## Phase 5 - Tests

- [x] T020 Add icon tests: dimensions, RGBA length, transparency, opaque
      pixels, multiple sizes.
- [x] T021 Add server-manager tests: target resolution, reuse without spawn,
      spawn + health wait, timeout, child exit, restart, ownership-aware stop,
      bounded output.
- [x] T022 Add CLI tests for help entries and `gui --dry-run` dispatch.

## Phase 6 - Documentation

- [x] T023 Add `docs/GUI.md` with prerequisites, usage, tray menu, auth/LAN
      behavior, standalone/Docker boundaries and troubleshooting.
- [x] T024 Add a compact GUI section to `README.md`, `README.es.md` and
      `README.pt-BR.md`.
- [x] T025 Mark spec/plan status and check off this task list when verified.

## Phase 7 - Verification

- [x] T026 `npm run typecheck` passes.
- [x] T027 Focused GUI/CLI tests pass.
- [x] T028 Full `npm run test:mock` passes.
- [x] T029 `npm run build` emits `dist/gui/main.js` and keeps the webview
      package external.
- [x] T030 Manual Windows smoke: tray icon, left/right click, close-to-tray,
      Restart server, Quit, no orphan process.

      Automated smoke on Windows passed: the tray/window were created with
      WebView2, the GUI reused a healthy external server, and the webview
      loaded `/admin` (`GET /health`, `GET /admin`, `GET /favicon.ico`).
      Auto-login was confirmed end to end: the GUI recorded `session.login` in
      the audit trail, produced no fallback warning, and WebView2 accepted the
      `qpx_admin` cookie for `127.0.0.1` with `HttpOnly` + `SameSite=Strict`.
      Tray interactions were driven with UI Automation:
      - left-click raised the dashboard window;
      - closing the window hid it while the GUI and the external server stayed
        alive (close-to-tray);
      - the tray menu exposed `Open dashboard | Restart server | Quit`;
      - `Open dashboard` restored the window;
      - `Restart server` reloaded the dashboard and re-authenticated (new
        `session.login` audit row, GUI + external server still alive);
      - `Quit` exited the GUI (PID gone, tray icon removed) while the external
        server kept running, leaving no orphan process.

## Phase 8 - Dashboard auto-login

- [x] T031 Add `src/gui/dashboard-auth.ts`: POST `/admin/api/session` with
      `QWEN_GUI_ADMIN_KEY || API_KEY`, parse `Set-Cookie`, build the
      `qpx_admin` cookie and inject it through the webview.
- [x] T032 Guard auto-login to loopback targets and fall back to the login form
      on timeout, network error, non-2xx, missing cookie or cookie rejection.
- [x] T033 Call auto-login in `connectDashboard()` after `/health` and before
      `view.loadUrl(/admin)`.
- [x] T034 Add `src/tests/gui-dashboard-auth.test.ts` and register it in
      `test:mock` / `test:mock:fast`.
- [x] T035 Document auto-login, `QWEN_GUI_ADMIN_KEY` and `QWEN_GUI_DEVTOOLS` in
      `docs/GUI.md`, the READMEs and `.env.example`.
- [x] T036 Spawn the server child with `windowsHide: true` and piped stdio, and
      assert the option in the server-manager tests (constitution principle X).

## Verification

- `npm run typecheck`: pass.
- Focused GUI/CLI tests: 30 pass, 0 fail (icon, server-manager, main, dashboard
  auth, CLI).
- Full `npm run test:mock`: 1037 pass, 0 fail (175 s).
- Auto-login against a live server: `POST /admin/api/session` returned a
  `qpx_admin` cookie (231-byte token) and the client built the correct
  `127.0.0.1` domain, `/` path, `HttpOnly`, `SameSite=Strict` attributes.
- `npm run build`: emits `dist/gui/main.js` with `@webviewjs/webview` external.
- `qpx gui --dry-run`: prints `GUI_ENTRY=src/gui/main.ts`, exit 0.
- `qpx gui --help`: lists the GUI command and `--gui`, exit 0.
- `@webviewjs/webview` 0.6.0 imports successfully on Node 24.13.0.

## Dependencies

- T004-T007 before T008-T013.
- T014-T019 after the module entrypoints exist.
- T020-T022 after T004-T017.
- T026-T029 after all code and tests.
- T030 requires a Windows desktop session.
