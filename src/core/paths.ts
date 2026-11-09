/**
 * QwenProxy - Unified Cross-Platform Storage & Path Resolution Engine
 *
 * Provides resilient, OS-standard persistent data paths for:
 * - SQLite Database & WAL logs
 * - AES-256-GCM Master Encryption Key
 * - Chromium persistent browser profiles (cookies & session storage)
 * - Account priority & AI client sync caches
 *
 * Guarantees zero data loss on package reinstall/update across npm, pnpm, bun, and yarn.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface ResolveDataDirOptions {
  envDataDir?: string;
  isNodeTest?: boolean;
  localDataExists?: boolean;
  executableDir?: string;
  executableDataExists?: boolean;
  platform?: NodeJS.Platform;
  appData?: string;
  homeDir?: string;
  xdgDataHome?: string;
}

/**
 * Directory of a packaged executable. Node/Bun development runtimes are
 * ignored so `npm start` never treats the runtime's install directory as a
 * portable install location.
 */
function defaultExecutableDir(): string | undefined {
  try {
    const base = path
      .basename(process.execPath)
      .toLowerCase()
      .replace(/\.exe$/, "");
    if (base === "node" || base === "bun") return undefined;
    return path.dirname(process.execPath);
  } catch {
    return undefined;
  }
}

/** `.env` placed next to a packaged executable (portable install). */
function executableEnvPath(): string | undefined {
  const dir = defaultExecutableDir();
  if (!dir) return undefined;
  const candidate = path.join(dir, ".env");
  try {
    return fs.existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Checks if the current process is running as a unit/mock test.
 */
export function isRunningUnderNodeTest(): boolean {
  return process.argv.some(
    (arg) =>
      arg === "--test" ||
      arg.includes("src/tests/") ||
      arg.includes("src\\tests\\"),
  );
}

/**
 * Computes the canonical global user data directory according to OS conventions:
 * - Windows: %APPDATA%\qwenproxy
 * - macOS:   ~/Library/Application Support/qwenproxy
 * - Linux:   $XDG_DATA_HOME/qwenproxy or ~/.local/share/qwenproxy
 */
export function getOsGlobalDataDir(options?: {
  platform?: NodeJS.Platform;
  appData?: string;
  homeDir?: string;
  xdgDataHome?: string;
}): string {
  const currentPlatform = options?.platform || process.platform;
  const home = options?.homeDir || os.homedir();

  if (currentPlatform === "win32") {
    const winPath = path.win32 || path;
    const appData =
      options?.appData ||
      process.env.APPDATA ||
      winPath.join(home, "AppData", "Roaming");
    return winPath.join(appData, "qwenproxy");
  }

  if (currentPlatform === "darwin") {
    return path.join(home, "Library", "Application Support", "qwenproxy");
  }

  // Linux / BSD / POSIX
  const xdgDataHome =
    options?.xdgDataHome ||
    process.env.XDG_DATA_HOME ||
    path.join(home, ".local", "share");
  return path.join(xdgDataHome, "qwenproxy");
}

/**
 * Resolves the active data directory based on environment, testing state,
 * local checkout presence, or the persistent global OS user directory.
 */
export function resolveDataDir(options?: ResolveDataDirOptions): string {
  // 1. Explicit environment variable override takes top precedence
  const envDir = options?.envDataDir ?? process.env.QWEN_DATA_DIR;
  if (envDir && envDir.trim().length > 0) {
    return path.resolve(envDir.trim());
  }

  // 2. Automated test isolation
  const isTest = options?.isNodeTest ?? isRunningUnderNodeTest();
  if (isTest) {
    return path.resolve("data-test");
  }
  // 3. Portable install: a `data` directory next to the executable wins over
  // the current directory so a binary can be moved with its data.
  const executableDir = options?.executableDir ?? defaultExecutableDir();
  const executableDataExists =
    options?.executableDataExists ??
    (executableDir
      ? fs.existsSync(path.join(executableDir, "data"))
      : false);
  if (executableDir && executableDataExists) {
    return path.resolve(executableDir, "data");
  }

  // 4. Local repository checkout (development mode)
  const localDir = path.resolve("data");
  const localExists =
    options?.localDataExists ??
    (fs.existsSync(path.join(localDir, "db", "qwenproxy.db")) ||
      fs.existsSync(localDir));

  if (localExists) {
    return localDir;
  }

  // 5. Global OS user directory (npm/pnpm/bun/yarn global mode)
  return getOsGlobalDataDir({
    platform: options?.platform,
    appData: options?.appData,
    homeDir: options?.homeDir,
    xdgDataHome: options?.xdgDataHome,
  });
}

/**
 * Returns the active root data directory.
 */
export function getDataDir(): string {
  return resolveDataDir();
}

/**
 * Directory for SQLite database and encryption key.
 */
export function getDbDir(customDataDir?: string): string {
  return path.join(customDataDir || getDataDir(), "db");
}

/**
 * Absolute path to the SQLite database file.
 */
export function getDbPath(customDataDir?: string): string {
  return path.join(getDbDir(customDataDir), "qwenproxy.db");
}

/**
 * Absolute path to the master AES-256 encryption key.
 */
export function getEncryptionKeyPath(customDataDir?: string): string {
  return path.join(getDbDir(customDataDir), ".encryption_key");
}

/**
 * Directory for persistent Chromium browser profiles.
 */
export function getProfilesDir(customDataDir?: string): string {
  return path.join(customDataDir || getDataDir(), "qwen_profiles");
}

/**
 * Path to a specific account's Chromium profile directory.
 */
export function getAccountProfilePath(accountId: string, customDataDir?: string): string {
  return path.join(getProfilesDir(customDataDir), accountId);
}

/**
 * Path to account priority persistence file.
 */
export function getAccountPriorityPath(customDataDir?: string): string {
  return path.join(customDataDir || getDataDir(), "account-priority.json");
}

/**
 * Path to AI coding clients synchronization state file.
 */
export function getSyncStatePath(customDataDir?: string): string {
  return path.join(customDataDir || getDataDir(), "sync-state.json");
}

/**
 * Path to TUI user preferences file (model, effort, last tab, etc.).
 */
export function getTuiSettingsPath(customDataDir?: string): string {
  return path.join(customDataDir || getDataDir(), "tui-settings.json");
}

/**
 * Path to the runtime model mapping file (alias -> Qwen id).
 *
 * The file is managed by the admin API/dashboard and reloaded on mtime
 * changes, so mapping edits never require a process restart.
 */
export function getModelMappingsPath(customDataDir?: string): string {
  return path.join(customDataDir || getDataDir(), "model-mappings.json");
}

/**
 * Path to user configuration .env file (either local or in global data dir).
 */
export function getEnvFilePath(customDataDir?: string): string {
  if (isRunningUnderNodeTest()) {
    return path.join(customDataDir || getDataDir(), ".env");
  }
  // Packaged binaries are often launched from a shortcut or service manager,
  // so a `.env` beside the executable is the most predictable location.
  const portableEnv = executableEnvPath();
  if (portableEnv) return portableEnv;
  const localEnv = path.resolve(".env");
  if (fs.existsSync(localEnv)) {
    return localEnv;
  }
  return path.join(customDataDir || getDataDir(), ".env");
}

/**
 * Path to logs directory.
 */
export function getLogsDir(customDataDir?: string): string {
  return path.join(customDataDir || getDataDir(), "logs");
}

/**
 * Path to persistent server log file.
 */
export function getServerLogFilePath(customDataDir?: string): string {
  return path.join(getLogsDir(customDataDir), "server.log");
}

/**
 * Ensures all standard directories exist on disk with proper recursive creation.
 */
export function ensureDataDirs(targetDataDir?: string): void {
  const root = targetDataDir || getDataDir();
  const dbDir = getDbDir(root);
  const profilesDir = getProfilesDir(root);
  const logsDir = getLogsDir(root);

  try {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  } catch (err: any) {
    console.error(`[Paths] Error ensuring data directories at ${root}:`, err?.message || String(err));
  }
}
