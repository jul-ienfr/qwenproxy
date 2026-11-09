/**
 * QwenProxy desktop shell.
 *
 * `qpx gui` / `qpx --gui` starts the normal server as a child process, then
 * opens the existing web dashboard in a native window with a notification-area
 * tray icon. The proxy, Playwright and the database stay in the child; this
 * process only renders the dashboard and supervises the child.
 *
 * `@webviewjs/webview` is an optional native dependency and is loaded lazily so
 * every non-GUI command (and `tsc`) works without it.
 */

process.env.DOTENV_CONFIG_QUIET = "true";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTrayIcon,
  createWindowIcon,
  type RgbaIcon,
} from "./icon.ts";
import {
  resolveServerCommand,
  resolveServerTarget,
  ServerManager,
  type ServerExitInfo,
  type ServerTarget,
} from "./server-manager.ts";
import { loginDashboard } from "./dashboard-auth.ts";

export interface GuiArgs {
  port?: number;
  help: boolean;
}

const MENU_OPEN = "open-dashboard";
const MENU_RESTART = "restart-server";
const MENU_QUIT = "quit";

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port '${value}'. Expected an integer from 1 to 65535.`);
  }
  return port;
}

/** Parses GUI-only flags. Unknown flags are ignored so `qpx gui --tui` is safe. */
export function parseGuiArgs(argv: string[]): GuiArgs {
  const options: GuiArgs = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--port") {
      const value = argv[index + 1];
      if (!value) throw new Error("--port requires a value.");
      options.port = parsePort(value);
      index += 1;
    } else if (arg.startsWith("--port=")) {
      options.port = parsePort(arg.slice("--port=".length));
    }
  }
  return options;
}

export function printGuiHelp(): void {
  console.log(`
QwenProxy desktop GUI

Usage:
  qpx gui [--port <num>]
  qpx --gui [--port <num>]

Starts the proxy when needed and opens the web dashboard in a native window.
A tray icon stays available after the window is closed.

Requirements:
  - Windows 10/11 (WebView2), macOS or a Linux desktop session
  - Node.js 24 or newer
  - Optional dependency @webviewjs/webview

The tray menu offers Open dashboard, Restart server and Quit.
`);
}

function assertRuntimeSupported(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 24) {
    throw new Error(
      `The desktop GUI requires Node.js 24+ (current ${process.version}). ` +
        "Use `qpx start`, the TUI, Docker or a standalone server binary on this Node version.",
    );
  }
  if (
    process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  ) {
    throw new Error(
      "The desktop GUI needs a graphical session (DISPLAY or WAYLAND_DISPLAY). " +
        "Use `qpx start` or the TUI on headless servers.",
    );
  }
}

interface WebviewModule {
  Application: new () => any;
}

/**
 * Loads the optional native package through a non-literal specifier so a
 * missing package is a clear runtime error instead of a build/type error.
 */
export async function loadWebviewModule(): Promise<WebviewModule> {
  const moduleName: string = "@webviewjs/webview";
  try {
    return (await import(moduleName)) as WebviewModule;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The desktop GUI needs the optional package @webviewjs/webview.\n` +
        `Install it with: npm install @webviewjs/webview\n` +
        `On Windows, the Microsoft Edge WebView2 runtime must also be installed.\n\n` +
        `Original error: ${detail}`,
    );
  }
}

export function isAllowedNavigation(url: string, origin: string): boolean {
  if (!url || url === "about:blank" || url.startsWith("data:")) return true;
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PAGE_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: grid; place-items: center;
  font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
  background: radial-gradient(circle at 30% 20%, #312e81, #111827 70%);
  color: #f8fafc;
}
.card {
  width: min(720px, calc(100vw - 48px)); padding: 32px 36px;
  border-radius: 18px; background: rgba(15, 23, 42, .82);
  border: 1px solid rgba(148, 163, 184, .25);
  box-shadow: 0 24px 80px rgba(0, 0, 0, .45);
}
h1 { margin: 0 0 8px; font-size: 1.45rem; letter-spacing: .02em; }
p { color: #cbd5e1; line-height: 1.55; }
a { color: #a5b4fc; }
code, pre { font-family: "Cascadia Code", Consolas, monospace; }
pre {
  margin: 18px 0 0; padding: 14px 16px; overflow: auto; max-height: 46vh;
  border-radius: 10px; background: rgba(2, 6, 23, .75);
  border: 1px solid rgba(148, 163, 184, .2);
  color: #e2e8f0; white-space: pre-wrap; word-break: break-word; font-size: .86rem;
}
.hint { margin-top: 18px; font-size: .92rem; color: #fbbf24; }
.spinner {
  width: 46px; height: 46px; margin-bottom: 22px; border-radius: 50%;
  border: 4px solid rgba(165, 180, 252, .25); border-top-color: #a5b4fc;
  animation: spin 900ms linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
`;

function loadingPage(target: ServerTarget): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>QwenProxy</title><style>${PAGE_STYLE}</style></head>
<body><main class="card">
  <div class="spinner"></div>
  <h1>Starting QwenProxy…</h1>
  <p>The dashboard opens as soon as the local server answers.</p>
  <p><code>${escapeHtml(target.dashboardUrl)}</code></p>
</main></body></html>`;
}

function errorPage(message: string, target: ServerTarget): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>QwenProxy — startup failed</title><style>${PAGE_STYLE}</style></head>
<body><main class="card">
  <h1>QwenProxy could not start</h1>
  <p>The dashboard is unavailable. Fix the issue below, then choose
     <strong>Restart server</strong> from the tray menu.</p>
  <pre>${escapeHtml(message)}</pre>
  <p class="hint">Expected dashboard: <code>${escapeHtml(target.dashboardUrl)}</code></p>
</main></body></html>`;
}

function pickWindowIcon(): RgbaIcon {
  return createWindowIcon();
}

function pickTrayIcon(): RgbaIcon {
  return createTrayIcon();
}

export interface RunGuiOptions {
  argv?: string[];
  /** Injected for tests; production uses the real child process + fetch. */
  manager?: ServerManager;
}

/**
 * Starts the desktop shell. Returns only when the GUI exits; the process then
 * terminates with the returned exit code.
 */
export async function runGui(options: RunGuiOptions = {}): Promise<number> {
  const args = parseGuiArgs(options.argv ?? process.argv.slice(2));
  if (args.help) {
    printGuiHelp();
    return 0;
  }

  // Apply the CLI port before importing config: both the GUI URL and the child
  // process must agree on the port.
  if (args.port !== undefined) {
    process.env.PORT = String(args.port);
  }

  assertRuntimeSupported();

  const paths = await import("../core/paths.ts");
  paths.ensureDataDirs();

  const dotenvModule = await import("dotenv");
  const dotenvConfig = dotenvModule.default?.config ?? dotenvModule.config;
  const envPath = paths.getEnvFilePath();
  if (fs.existsSync(envPath)) {
    dotenvConfig({ path: envPath, quiet: true });
  } else {
    dotenvConfig({ quiet: true });
  }

  const { config } = await import("../core/config.ts");
  const target = resolveServerTarget(config.server.host, config.server.port);
  // Auto-login credential: an explicit override wins over the global API_KEY.
  // An empty key still works on a no-key loopback server (local admin).
  const adminKey = (
    process.env.QWEN_GUI_ADMIN_KEY ||
    config.apiKey ||
    process.env.API_KEY ||
    ""
  ).trim();
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const command = resolveServerCommand({ packageRoot });

  let manager = options.manager;
  if (!manager) {
    manager = new ServerManager({
      target,
      command,
      cwd: process.cwd(),
      env: process.env,
    });
  }

  // Load the native module before the server starts: a missing package should
  // not leave a child process behind.
  const webview = await loadWebviewModule();
  const { Application } = webview;

  let app: any = null;
  let tray: any = null;
  let window: any = null;
  let view: any = null;
  let webContext: any = null;
  let quitting = false;
  let serverReady = false;
  let restarting = false;
  let shutdownPromise: Promise<void> | null = null;

  const showWindow = () => {
    if (quitting) return;
    try {
      window?.show();
      window?.setVisible(true);
      window?.focus();
    } catch {}
    if (!serverReady && !restarting) {
      void connectDashboard();
    }
  };

  const setTrayTooltip = (text: string) => {
    try {
      tray?.setTooltip(text);
    } catch {}
  };

  const shutdown = (code: number): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    quitting = true;
    shutdownPromise = (async () => {
      try {
        await manager!.stop();
      } catch {}
      try {
        tray?.setVisible(false);
        tray?.dispose();
      } catch {}
      try {
        app?.exit();
      } catch {}
      process.exit(code);
    })();
    return shutdownPromise;
  };

  const connectDashboard = async (): Promise<void> => {
    if (quitting) return;
    if (restarting) return;
    restarting = true;
    setTrayTooltip("QwenProxy — starting server…");
    try {
      await manager!.start();
      if (quitting) return;
      serverReady = true;
      setTrayTooltip(`QwenProxy — ${target.dashboardUrl}`);
      if (view) {
        const auth = await loginDashboard(view, { target, apiKey: adminKey });
        if (!auth.ok) {
          console.warn(
            `⚠️  [GUI] Dashboard auto-login unavailable (${auth.reason}); showing the login form.`,
          );
        }
      }
      if (quitting) return;
      view.loadUrl(target.dashboardUrl);
    } catch (error) {
      if (quitting) return;
      serverReady = false;
      const message = error instanceof Error ? error.message : String(error);
      setTrayTooltip("QwenProxy — server unavailable");
      try {
        view.loadHtml(errorPage(message, target));
      } catch {}
      console.error(`❌ [GUI] ${message}`);
    } finally {
      restarting = false;
    }
  };

  try {
    app = new Application();
    await app.whenReady();

    const trayIcon = pickTrayIcon();
    const windowIcon = pickWindowIcon();

    tray = app.createTrayIcon({
      id: "qwenproxy-main",
      icon: {
        data: trayIcon.data,
        width: trayIcon.width,
        height: trayIcon.height,
      },
      tooltip: `QwenProxy — ${target.dashboardUrl}`,
      menu: {
        items: [
          { id: MENU_OPEN, label: "Open dashboard" },
          { id: MENU_RESTART, label: "Restart server" },
          { role: "separator" },
          { id: MENU_QUIT, label: "Quit" },
        ],
      },
      menuOnLeftClick: false,
      menuOnRightClick: true,
    });

    tray.on("click", (payload: { button?: string }) => {
      // Right-click opens the native menu; any other click raises the window.
      // The payload casing differs across platforms, so match right explicitly.
      if (payload?.button && /right/i.test(payload.button)) return;
      showWindow();
    });

    window = app.createBrowserWindow({
      title: "QwenProxy Dashboard",
      width: 1280,
      height: 820,
      logical: true,
      resizable: true,
      visible: true,
      focused: true,
    });
    try {
      window.setMinSize(900, 600, true);
    } catch {}
    try {
      window.setWindowIcon(windowIcon.data, windowIcon.width, windowIcon.height);
    } catch {}

    window.on("close", (event: { preventDefault?: () => void }) => {
      // Closing hides to the tray; Quit is the only exit path.
      event?.preventDefault?.();
      try {
        window?.hide();
      } catch {}
    });

    const webviewDir = path.join(paths.getDataDir(), "gui-webview");
    try {
      fs.mkdirSync(webviewDir, { recursive: true });
    } catch {}
    try {
      webContext = app.createWebContext({ dataDirectory: webviewDir });
    } catch {
      webContext = null;
    }

    view = window.createWebview({
      html: loadingPage(target),
      ...(webContext ? { webContext } : {}),
      enableDevtools: process.env.QWEN_GUI_DEVTOOLS === "true",
      navigationHandler: (url: string) => isAllowedNavigation(url, target.origin),
      newWindowHandler: () => false,
    });

    app.on(
      "custom-menu-click",
      (event: { customMenuEvent?: { id?: string } }) => {
        const id = event?.customMenuEvent?.id;
        if (id === MENU_OPEN) {
          showWindow();
        } else if (id === MENU_RESTART) {
          serverReady = false;
          void connectDashboard();
        } else if (id === MENU_QUIT) {
          void shutdown(0);
        }
      },
    );

    // The tray keeps the application alive when the last window is hidden.
    app.on("application-close-requested", () => {});

    manager!.on("ready", () => {
      setTrayTooltip(`QwenProxy — ${target.dashboardUrl}`);
    });
    manager!.on("exit", (info: ServerExitInfo) => {
      if (quitting || info.expected) return;
      serverReady = false;
      setTrayTooltip("QwenProxy — server stopped");
      try {
        view.loadHtml(
          errorPage(
            `The server process stopped unexpectedly (code ${
              info.code ?? "null"
            }${info.signal ? `, signal ${info.signal}` : ""}).`,
            target,
          ),
        );
      } catch {}
    });

    process.on("SIGINT", () => {
      void shutdown(130);
    });
    process.on("SIGTERM", () => {
      void shutdown(143);
    });
    process.on("uncaughtException", (error) => {
      console.error("❌ [GUI] Uncaught exception:", error);
      void shutdown(1);
    });
    process.on("unhandledRejection", (reason) => {
      console.error("❌ [GUI] Unhandled rejection:", reason);
      void shutdown(1);
    });
    process.on("exit", () => {
      try {
        manager!.stopSync();
      } catch {}
    });

    void connectDashboard();

    // `whenReady()` keeps the event pump alive, so the promise resolves only
    // through shutdown(), which calls process.exit().
    return await new Promise<number>(() => {});
  } catch (error) {
    quitting = true;
    try {
      await manager?.stop();
    } catch {}
    try {
      tray?.dispose();
    } catch {}
    try {
      app?.exit();
    } catch {}
    throw error;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/**
 * `bin/qwenproxy.js` sets an explicit marker because path translation layers
 * (junctions, containers, `tsx`) can make `argv[1]` and `import.meta.url`
 * disagree even though this file really is the entrypoint.
 */
export function shouldStartGui(): boolean {
  return process.env.QWENPROXY_GUI_AUTOSTART === "1" || isDirectRun();
}

if (shouldStartGui()) {
  runGui()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`❌ [GUI] ${message}`);
      process.exit(1);
    });
}
