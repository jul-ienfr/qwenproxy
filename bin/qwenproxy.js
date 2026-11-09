#!/usr/bin/env node

/**
 * QwenProxy - Unified CLI Entrypoint & Runner
 *
 * Commands:
 *   qwenproxy (default) -> Launches the interactive TUI management dashboard and proxy
 *   qwenproxy --server  -> Runs headless proxy server in background
 *   qwenproxy sync      -> Synchronizes AI coding clients (Claude Code, Codex, OpenCode, OMP)
 *   qwenproxy clean     -> Prunes transient caches
 *   qwenproxy clean:all -> Reclaims unused Playwright browsers and caches
 *   qwenproxy reset     -> Resets rate-limit and auth cooldowns
 *   qwenproxy purge     -> Deletes remote chats across configured accounts
 *   qwenproxy login     -> Authenticates accounts via visible browser
 *   qwenproxy gui       -> Desktop tray icon with the dashboard in a webview
 */
process.env.DOTENV_CONFIG_QUIET = "true";

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(packageRoot, "package.json");
const buildMetaPath = path.join(packageRoot, "dist", "build-meta.json");

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

const rawArgs = process.argv.slice(2);
const firstArg = rawArgs[0]?.toLowerCase();

// 1. Version check
if (rawArgs.includes("-v") || rawArgs.includes("--version") || firstArg === "version") {
  const pkg = readJsonFile(packageJsonPath);
  const meta = readJsonFile(buildMetaPath);
  const version = meta.version || pkg.version || "1.0.0";
  const commit =
    process.env.QWENPROXY_BUILD_COMMIT ||
    process.env.GIT_COMMIT ||
    process.env.GITHUB_SHA ||
    (meta.commit && meta.commit !== "unknown" ? meta.commit : "");
  console.log(
    `QwenProxy v${version}${commit ? ` (commit ${String(commit).slice(0, 12)})` : ""}`,
  );
  process.exit(0);
}

// 2. Help check
if (rawArgs.includes("-h") || rawArgs.includes("--help") || firstArg === "help") {
  console.log(`
QwenProxy — High-performance AI Coding Gateway & Management TUI

Usage:
  qpx [options] [command]
Commands:
  (default)     Launch interactive TUI management dashboard and proxy
  start         Run headless HTTP/SSE proxy server
  update        Check for updates and automatically update (npm, pnpm, bun)
  login         Authenticate new accounts via visible browser
  sync          Synchronize AI clients (Claude Code, Codex, OpenCode, OMP)
  clean         Prune transient profile caches
  clean:all     Prune profile caches and clean unused Playwright browsers
  reset         Reset rate-limit and auth cooldowns in database
  purge         Delete remote chats across configured accounts
  gui           Open the desktop tray icon and dashboard webview

Options:
  --tui         Open interactive TUI dashboard (default)
  --server      Run in headless server mode
  --gui         Open the desktop tray icon and dashboard webview
  --port <num>  Override server listening port (default: 7936)
  -v, --version Show version number
  -h, --help    Show this help message
`);
  process.exit(0);
}
// 2.5 Pure Node update execution (bypasses tsx and esbuild.exe locks)
if (firstArg === "update") {
  const { runUpdateCommand } = await import("./update.js");
  await runUpdateCommand();
} else {

// 3. Command dispatcher
let scriptFile = "src/index.ts";
let scriptArgs = [];

const isGuiCommand = firstArg === "gui" || rawArgs.includes("--gui");

/** `--port <n>` / `--port=<n>` must reach both the GUI and its server child. */
function readPortOption(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--port") {
      return args[index + 1];
    }
    if (arg.startsWith("--port=")) {
      return arg.slice("--port=".length);
    }
  }
  return undefined;
}

if (isGuiCommand) {
  const port = readPortOption(rawArgs);
  if (port !== undefined) {
    process.env.PORT = String(port);
  }
  if (rawArgs.includes("--dry-run")) {
    console.log("GUI_ENTRY=src/gui/main.ts");
    process.exit(0);
  }
  // The GUI entrypoint verifies it is the main module, but junctions and tsx
  // path translation can make that check ambiguous; use an explicit marker.
  process.env.QWENPROXY_GUI_AUTOSTART = "1";
  scriptFile = "src/gui/main.ts";
  scriptArgs = rawArgs.filter((arg) => arg !== "gui" && arg !== "--gui");
} else if (firstArg === "start" || rawArgs.includes("--server")) {
  scriptFile = "src/index.ts";
  scriptArgs = rawArgs.filter((a) => a !== "start" && a !== "--server");
} else if (firstArg === "tui" || rawArgs.includes("--tui") || rawArgs.length === 0) {
  scriptFile = "src/index.ts";
  scriptArgs = ["--tui", ...rawArgs.filter((a) => a !== "tui" && a !== "--tui")];
} else if (firstArg === "sync") {
  scriptFile = "src/sync-clients.ts";
  scriptArgs = rawArgs.slice(1);
} else if (firstArg === "clean") {
  scriptFile = "src/clean-cache.ts";
  scriptArgs = rawArgs.slice(1);
} else if (firstArg === "clean:all") {
  scriptFile = "src/clean-cache.ts";
  scriptArgs = ["--all", ...rawArgs.slice(1)];
} else if (firstArg === "reset") {
  scriptFile = "src/reset-cooldowns.ts";
  scriptArgs = rawArgs.slice(1);
} else if (firstArg === "purge") {
  scriptFile = "src/delete-chats.ts";
  scriptArgs = rawArgs.slice(1);
} else if (firstArg === "login") {
  scriptFile = "src/login.ts";
  scriptArgs = rawArgs.slice(1);
} else {
  // Pass through remaining options to index.ts with default TUI flag
  scriptFile = "src/index.ts";
  scriptArgs = ["--tui", ...rawArgs];
}

const distFile = scriptFile.replace(/^src[\\/]/, "dist/").replace(/\.ts$/, ".js");
const distPath = path.resolve(packageRoot, distFile);
let targetPath = path.resolve(packageRoot, scriptFile);
let runWithTsx = true;

if (fs.existsSync(distPath)) {
  targetPath = distPath;
  runWithTsx = false;
}

// Resolve tsx loader relative to the package installation rather than cwd
let tsxLoaderArg = "tsx";
if (runWithTsx) {
  try {
    const tsxEntry = require.resolve("tsx");
    tsxLoaderArg = pathToFileURL(tsxEntry).href;
  } catch {}
}

// Ensure Playwright Chromium is installed only for commands that need the browser
const browserCommands = ["start", "tui", "login", "gui"];
const isBrowserCommand =
  !firstArg ||
  browserCommands.includes(firstArg) ||
  rawArgs.includes("--tui") ||
  rawArgs.includes("--server") ||
  rawArgs.includes("--gui");

if (isBrowserCommand) {
  try {
    const { chromium } = await import("patchright");
    const execPath = chromium.executablePath();
    if (!fs.existsSync(execPath)) {
      console.log("⏳ [QwenProxy] Instalando o navegador Chromium pela primeira vez...");
      let cliPath = "";
      try {
        const patchrightEntry = require.resolve("patchright");
        cliPath = path.join(path.dirname(patchrightEntry), "cli.js");
      } catch {}

      const runInstall = (mirrorHost) => {
        const installEnv = {
          ...process.env,
          PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT:
            process.env.PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT || "120000",
          ...(mirrorHost ? { PLAYWRIGHT_DOWNLOAD_HOST: mirrorHost } : {}),
        };

        if (cliPath && fs.existsSync(cliPath)) {
          return spawnSync(process.execPath, [cliPath, "install", "chromium"], {
            stdio: "inherit",
            env: installEnv,
          });
        }
        const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
        return spawnSync(cmd, ["--yes", "patchright", "install", "chromium"], {
          stdio: "inherit",
          env: installEnv,
        });
      };

      let chosenHost = process.env.PLAYWRIGHT_DOWNLOAD_HOST;
      if (!chosenHost) {
        // Probe official CDN; if unresponsive within 2s, switch to global mirror immediately
        const controller = new AbortController();
        const probeTimer = setTimeout(() => controller.abort(), 2000);
        try {
          const probe = await fetch("https://cdn.playwright.dev", { method: "HEAD", signal: controller.signal });
          clearTimeout(probeTimer);
          if (probe.status >= 500) chosenHost = "https://npmmirror.com/mirrors/playwright";
        } catch {
          clearTimeout(probeTimer);
          chosenHost = "https://npmmirror.com/mirrors/playwright";
          console.log("🌐 [QwenProxy] CDN oficial indisponível na sua região. Usando espelho global de alta velocidade...");
        }
      }

      let res = runInstall(chosenHost);
      if (res.status !== 0 && !chosenHost) {
        console.log("\n⚠️ [QwenProxy] Falha no CDN primário. Tentando espelho global de alta velocidade...");
        res = runInstall("https://npmmirror.com/mirrors/playwright");
      }

      if (res.status === 0) {
        console.log("✓ [QwenProxy] Navegador instalado com sucesso!\n");
        // Automatically prune older, unused browser builds to free up disk space
        try {
          const cleanModule = fs.existsSync(path.resolve(packageRoot, "dist/clean-cache.js"))
            ? await import("../dist/clean-cache.js")
            : await import("../src/clean-cache.ts");
          if (cleanModule.cleanPlaywrightBrowsers) {
            await cleanModule.cleanPlaywrightBrowsers(true);
          }
        } catch {}
      }
    }
  } catch {}
}

const nodeArgs = runWithTsx
  ? ["--import", tsxLoaderArg, targetPath, ...scriptArgs]
  : [targetPath, ...scriptArgs];

const child = spawn(process.execPath, nodeArgs, {
  stdio: "inherit",
  cwd: process.cwd(),
  env: process.env,
});

const restoreTerminal = () => {
  try {
    const RESET_SEQ = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[?25h\x1b[0m";
    fs.writeSync(1, RESET_SEQ);
  } catch {}
  if (process.stdin.setRawMode) {
    try {
      process.stdin.setRawMode(false);
    } catch {}
  }
};

child.on("exit", (code, signal) => {
  restoreTerminal();
  process.exit(code ?? (signal ? 1 : 0));
});

child.on("error", (err) => {
  restoreTerminal();
  console.error("❌ [QwenProxy] Failed to execute CLI script:", err.message);
  process.exit(1);
});

process.on("SIGINT", () => {
  restoreTerminal();
  process.exit(130);
});

process.on("SIGTERM", () => {
  restoreTerminal();
  process.exit(143);
});

process.on("exit", restoreTerminal);
}
