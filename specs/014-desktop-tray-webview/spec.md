# Feature Specification: Desktop Tray Icon and Dashboard Webview

**Feature Branch**: `014-desktop-tray-webview`

**Created**: 2026-11-09

**Status**: Implemented

**Input**: User request: "Sous Windows, quand le GUI est activé, un icône en bas
à droite dans la barre des tâches, à côté de l'heure. Je souhaite que cela ouvre
un webview, afin de pouvoir voir le tableau de bord hors du navigateur."

## Context

QwenProxy already serves the web administration dashboard from the proxy process
at `/admin`. Today the only desktop surface is the terminal UI, and viewing the
dashboard requires a browser tab. On Windows the user wants a persistent tray
icon that opens the same dashboard in an embedded webview, without Electron and
without changing the HTTP server, the dashboard, or LAN access.

The GUI is an optional desktop shell. It must not become required for `qpx`,
`qpx start`, Docker, or standalone server binaries.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Start the GUI and open the dashboard from the tray (Priority: P1)

The user runs `qpx gui` (or `qpx --gui`). A QwenProxy icon appears in the Windows
notification area. Left-clicking the icon shows a native window containing the
dashboard; right-clicking opens a menu.

**Why this priority**: This is the requested feature and the fastest path to the
dashboard outside a browser.

**Independent Test**: Run `qpx gui` on Windows, confirm the tray icon exists,
click it, and verify the window renders `http://127.0.0.1:<port>/admin`.

**Acceptance Scenarios**:

1. **Given** no QwenProxy server is running and the GUI package is installed,
   **When** the user runs `qpx gui`, **Then** the server starts, `/health` is
   polled until ready, and the dashboard window opens.
2. **Given** a QwenProxy server is already listening on the configured port,
   **When** the GUI starts, **Then** it reuses that server instead of spawning a
   second process.
3. **Given** the dashboard window is hidden, **When** the user left-clicks the
   tray icon, **Then** the window is shown and focused.
4. **Given** the tray icon, **When** the user right-clicks, **Then** a menu
   offers **Open dashboard**, **Restart server**, and **Quit**.

---

### User Story 2 - Closing the window keeps the tray alive (Priority: P1)

Closing the dashboard window hides it to the tray instead of terminating the
proxy, so the server keeps running.

**Why this priority**: A tray application that exits when its window closes is
not usable as a dashboard launcher.

**Independent Test**: Close the window, verify the tray icon remains, the server
still answers `/health`, and clicking the tray icon restores the window.

**Acceptance Scenarios**:

1. **Given** the window is open, **When** the user closes it, **Then** the window
   hides and the server continues running.
2. **Given** the user selects **Quit**, **Then** the GUI stops the server process
   it owns, removes the tray icon, and exits.
3. **Given** the GUI reused an external server, **When** the user selects
   **Quit**, **Then** the external server is left running.

---

### User Story 3 - Recover without a terminal (Priority: P2)

If the server fails to start or stops unexpectedly, the GUI shows an actionable
error in the webview and the tray menu can restart it.

**Why this priority**: GUI users may not have a terminal open; silent failure is
not acceptable.

**Independent Test**: Force a startup failure (for example no configured
accounts), verify the window shows the failure reason, then fix the condition and
use **Restart server**.

**Acceptance Scenarios**:

1. **Given** the server exits during startup, **When** the GUI detects the exit,
   **Then** the window shows the captured error output and the dashboard URL.
2. **Given** the error window, **When** the user chooses **Restart server**,
   **Then** the GUI starts a fresh child, waits for `/health`, and reloads the
   dashboard on success.
3. **Given** the webview package is missing or the Node version is too old,
   **Then** `qpx gui` prints an actionable message and exits non-zero without
   touching the server.

---

### User Story 4 - Preserve the existing security model (Priority: P2)

The GUI is a local client of the existing dashboard and does not weaken
authentication or network exposure.

**Why this priority**: The dashboard is the control plane for accounts, keys and
settings.

**Independent Test**: Run with `API_KEY` set and with `HOST=0.0.0.0`; verify the
webview uses `127.0.0.1`, the normal login flow applies, and LAN access from
another machine is unchanged.

**Acceptance Scenarios**:

1. **Given** `HOST=0.0.0.0`, **When** the GUI builds its URL, **Then** it uses
   `127.0.0.1` rather than the wildcard address.
2. **Given** `API_KEY` is set, **When** the dashboard opens, **Then** the normal
   session login is required inside the webview.
3. **Given** the webview, **When** the page tries to navigate to a foreign
   origin, **Then** navigation is blocked and stays on the dashboard origin.
4. **Given** the GUI is running, **Then** the HTTP server still binds according
   to `HOST`/`PORT` and remains reachable from allowed LAN clients.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `qpx gui` and `qpx --gui` MUST launch the desktop GUI. The command
  MUST be listed in `qpx --help`.
- **FR-002**: The GUI MUST create a tray icon on Windows and MUST expose
  **Open dashboard**, **Restart server**, and **Quit**.
- **FR-003**: A left-click on the tray icon MUST show and focus the dashboard
  window.
- **FR-004**: Closing the dashboard window MUST hide it to the tray, not exit.
- **FR-005**: **Quit** MUST stop a server child owned by the GUI and exit the
  GUI. It MUST NOT stop a server the GUI did not start.
- **FR-006**: The GUI MUST start the server child only when `/health` is not
  already answering, and MUST wait for `/health` before loading the dashboard.
- **FR-007**: When `HOST` is a wildcard address (`0.0.0.0`, `::`), the GUI MUST
  use `127.0.0.1` for its own dashboard URL.
- **FR-008**: The GUI MUST keep the dashboard session cookie in the user data
  directory so authentication survives window hide/show and GUI restarts.
- **FR-009**: GUI navigation MUST be restricted to the configured dashboard
  origin.
- **FR-010**: Missing GUI dependencies, unsupported Node versions, or an
  unsupported platform MUST produce an actionable error and a non-zero exit.
- **FR-011**: The GUI MUST NOT change OpenAI/Anthropic/Gemini routes, the
  `/admin` HTTP surface, or the search opt-in behavior.
- **FR-012**: The GUI MUST be an optional surface: `qpx`, `qpx start`, Docker,
  and standalone server binaries MUST keep working without it.

### Key Entities

- **Server target**: resolved host, port, health URL and dashboard URL.
- **Managed server**: child process spawned by the GUI, with readiness, exit
  status and recent output.
- **Tray icon**: native notification-area icon plus menu identifiers.
- **Dashboard webview**: one embedded webview bound to the dashboard origin with
  a persistent data directory.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On Windows, `qpx gui` shows a tray icon and the dashboard window
  within the normal server startup time plus at most 2 seconds.
- **SC-002**: With an already-running server, the GUI opens the dashboard without
  spawning a second process.
- **SC-003**: Closing the window keeps `/health` reachable; **Quit** removes the
  tray icon and leaves no orphan child process.
- **SC-004**: A failed startup displays the captured server error in the window
  within 1 second of detection.
- **SC-005**: No change in behavior for non-GUI commands, Docker, standalone
  binaries, or request routing (full mock suite remains green).

## Assumptions

- `@webviewjs/webview` provides the Windows WebView2 window and native tray icon
  and is acceptable as an optional dependency.
- The GUI targets Node.js 24+ where the webview native package is supported.
- The default install keeps the dashboard on loopback; LAN exposure remains an
  explicit `HOST`/`API_KEY` choice made by the operator.
- Standalone server binaries remain server-only; the GUI is an npm/Node install
  feature documented separately.

## Out of Scope

- Replacing the TUI.
- Packaging the GUI inside Bun standalone binaries.
- Auto-update, notifications, or a second dashboard implementation.
- Changing dashboard authentication or adding new admin endpoints.
