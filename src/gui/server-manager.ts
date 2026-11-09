/**
 * Supervises the QwenProxy HTTP server on behalf of the desktop shell.
 *
 * The GUI never imports the proxy, Playwright or the database directly: it
 * starts the normal server entrypoint as a child process and waits for
 * `/health`. If a server is already listening on the configured port, the GUI
 * reuses it and never takes ownership of that process.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

export interface ServerTarget {
  /** Host used by the GUI itself (wildcards become loopback). */
  host: string;
  port: number;
  origin: string;
  healthUrl: string;
  dashboardUrl: string;
}

export interface ServerCommand {
  command: string;
  args: string[];
}

export interface ManagedChild {
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio: ["ignore", "pipe", "pipe"];
  },
) => ManagedChild;

export interface ServerManagerLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface ServerExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  expected: boolean;
}

export interface ServerManagerOptions {
  target: ServerTarget;
  command: ServerCommand;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  healthTimeoutMs?: number;
  outputLines?: number;
  logger?: ServerManagerLogger;
}

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 1_500;
const DEFAULT_OUTPUT_LINES = 40;

function normalizeHost(host: string): string {
  const trimmed = (host || "").trim();
  if (!trimmed) return "127.0.0.1";

  const unbracketed = trimmed.replace(/^\[|\]$/g, "").toLowerCase();
  if (unbracketed === "0.0.0.0" || unbracketed === "::") {
    return "127.0.0.1";
  }
  return trimmed;
}

function formatUrlHost(host: string): string {
  const value = normalizeHost(host);
  const bare = value.replace(/^\[|\]$/g, "");
  return bare.includes(":") && !value.startsWith("[") ? `[${bare}]` : value;
}

export function resolveServerTarget(host: string, port: number): ServerTarget {
  const normalizedHost = normalizeHost(host);
  const origin = `http://${formatUrlHost(normalizedHost)}:${port}`;
  return {
    host: normalizedHost.replace(/^\[|\]$/g, ""),
    port,
    origin,
    healthUrl: `${origin}/health`,
    // The Hono admin app is mounted at `/admin` and does not serve the
    // trailing-slash variant, so the GUI must load the exact path.
    dashboardUrl: `${origin}/admin`,
  };
}

function resolveTsxLoader(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return require.resolve("tsx");
  } catch {
    return null;
  }
}

/**
 * Picks the server entrypoint that matches how the GUI itself was launched.
 * A built `dist/index.js` wins; a source checkout uses the same `tsx` loader
 * that `bin/qwenproxy.js` uses.
 */
export function resolveServerCommand(options: {
  packageRoot: string;
  execPath?: string;
  tsxLoader?: string | null;
}): ServerCommand {
  const execPath = options.execPath || process.execPath;
  const distEntry = path.join(options.packageRoot, "dist", "index.js");
  if (fs.existsSync(distEntry)) {
    return { command: execPath, args: [distEntry] };
  }

  const sourceEntry = path.join(options.packageRoot, "src", "index.ts");
  const loader =
    options.tsxLoader === undefined ? resolveTsxLoader() : options.tsxLoader;
  if (!loader) {
    throw new Error(
      "Cannot start the QwenProxy server: neither dist/index.js nor the tsx loader is available. Run `npm install` (or `npm run build`) first.",
    );
  }
  return {
    command: execPath,
    args: ["--import", pathToFileURL(loader).href, sourceEntry],
  };
}

function defaultLogger(): ServerManagerLogger {
  return {
    info: (message) => {
      try {
        process.stdout.write(`${message}\n`);
      } catch {}
    },
    error: (message) => {
      try {
        process.stderr.write(`${message}\n`);
      } catch {}
    },
  };
}

/**
 * Emits:
 * - `ready` when `/health` answers
 * - `exit` with `ServerExitInfo` when a spawned child exits
 * - `output` with each complete captured line
 */
export class ServerManager extends EventEmitter {
  readonly target: ServerTarget;
  private readonly command: ServerCommand;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnImpl: SpawnFn;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (milliseconds: number) => Promise<void>;
  private readonly nowImpl: () => number;
  private readonly pollIntervalMs: number;
  private readonly readyTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly maxOutputLines: number;
  private readonly logger: ServerManagerLogger;

  private child: ManagedChild | null = null;
  private running = false;
  private ownsServer = false;
  /** Set before stop(); consumed by the matching child's exit handler. */
  private expectedExit = false;
  private startPromise: Promise<void> | null = null;
  private readonly output: string[] = [];
  private readonly streamBuffers = new Map<string, string>();

  constructor(options: ServerManagerOptions) {
    super();
    this.target = options.target;
    this.command = options.command;
    this.cwd = options.cwd || process.cwd();
    this.env = options.env || process.env;
    this.spawnImpl =
      options.spawn || (spawn as unknown as SpawnFn);
    this.fetchImpl = options.fetch || ((...args) => fetch(...args));
    this.sleepImpl =
      options.sleep ||
      ((milliseconds) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, milliseconds);
          timer.unref?.();
        }));
    this.nowImpl = options.now || (() => Date.now());
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.healthTimeoutMs =
      options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.maxOutputLines = options.outputLines ?? DEFAULT_OUTPUT_LINES;
    this.logger = options.logger || defaultLogger();
  }

  get isRunning(): boolean {
    return this.running;
  }

  get ownsServerProcess(): boolean {
    return this.ownsServer;
  }

  get recentOutput(): string[] {
    return [...this.output];
  }

  /** One bounded probe; never throws. */
  async probeHealth(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, this.healthTimeoutMs),
    );
    timer.unref?.();
    try {
      const response = await this.fetchImpl(this.target.healthUrl, {
        method: "GET",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      return response.status >= 200 && response.status < 400;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reuse a healthy server, otherwise spawn the configured child and wait for
   * `/health`. Serialized so tray double-clicks cannot spawn twice.
   */
  start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.doStart().finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    if (this.running) {
      await this.waitForHealth();
      return;
    }

    if (await this.probeHealth()) {
      this.ownsServer = false;
      this.emit("ready");
      return;
    }

    this.spawnChild();
    await this.waitForReady();
    this.emit("ready");
  }

  private spawnChild(): void {
    this.logger.info(
      `[gui] Starting QwenProxy server: ${this.command.command} ${this.command.args.join(" ")}`,
    );
    let child: ManagedChild;
    try {
      child = this.spawnImpl(this.command.command, this.command.args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      this.running = false;
      this.ownsServer = false;
      throw error;
    }

    this.child = child;
    this.running = true;
    this.ownsServer = true;
    this.expectedExit = false;
    this.streamBuffers.clear();

    this.attachStream("stdout", child.stdout, (line) =>
      this.logger.info(line),
    );
    this.attachStream("stderr", child.stderr, (line) =>
      this.logger.error(line),
    );

    child.on("error", (error: Error) => {
      this.recordLine(`[gui] Server process error: ${error.message}`);
    });

    child.on(
      "exit",
      (code: number | null, signal: NodeJS.Signals | null) => {
        // A late event from a child that was already replaced must not touch
        // the current process state.
        if (this.child !== child) return;

        const expected = this.expectedExit;
        this.running = false;
        this.child = null;
        this.ownsServer = false;
        this.expectedExit = false;

        this.recordLine(
          `[gui] Server process exited (code ${code ?? "null"}${
            signal ? `, signal ${signal}` : ""
          }).`,
        );
        const info: ServerExitInfo = { code, signal, expected };
        this.emit("exit", info);
      },
    );
  }

  private attachStream(
    name: string,
    stream: NodeJS.ReadableStream | null,
    forward: (line: string) => void,
  ): void {
    if (!stream) return;
    stream.on("data", (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : chunk;
      const previous = this.streamBuffers.get(name) || "";
      const combined = previous + text;
      const lines = combined.split(/\r?\n/);
      const tail = lines.pop() ?? "";
      // Keep a generous partial line, but never grow without bound.
      this.streamBuffers.set(name, tail.slice(-8192));
      for (const line of lines) {
        if (!line.trim()) continue;
        this.recordLine(line);
        forward(line);
      }
    });
    stream.on("error", () => {});
  }

  private recordLine(line: string): void {
    this.output.push(line);
    if (this.output.length > this.maxOutputLines) {
      this.output.splice(0, this.output.length - this.maxOutputLines);
    }
    this.emit("output", line);
  }

  private async waitForHealth(): Promise<void> {
    const deadline = this.nowImpl() + this.readyTimeoutMs;
    let exitInfo: ServerExitInfo | null = null;
    const onExit = (info: ServerExitInfo) => {
      exitInfo = info;
    };
    this.on("exit", onExit);
    try {
      while (true) {
        if (await this.probeHealth()) return;
        if (exitInfo) {
          throw new Error(this.startupFailureMessage(exitInfo));
        }
        if (this.nowImpl() >= deadline) {
          throw new Error(this.timeoutMessage());
        }
        await this.sleepImpl(this.pollIntervalMs);
      }
    } finally {
      this.off("exit", onExit);
    }
  }

  private async waitForReady(): Promise<void> {
    const deadline = this.nowImpl() + this.readyTimeoutMs;
    let exitInfo: ServerExitInfo | null = null;
    const onExit = (info: ServerExitInfo) => {
      exitInfo = info;
    };
    this.on("exit", onExit);

    try {
      while (true) {
        if (await this.probeHealth()) {
          if (!this.running) {
            // The port is served, but not by our child (for example a server
            // that won the bind race). Reuse it instead of reporting failure.
            this.ownsServer = false;
          }
          return;
        }
        if (exitInfo) {
          throw new Error(this.startupFailureMessage(exitInfo));
        }
        if (this.nowImpl() >= deadline) {
          throw new Error(this.timeoutMessage());
        }
        await this.sleepImpl(this.pollIntervalMs);
      }
    } finally {
      this.off("exit", onExit);
    }
  }

  private recentOutputBlock(lines = 12): string {
    const tail = this.output.slice(-lines);
    return tail.length > 0 ? `\n\nRecent server output:\n${tail.join("\n")}` : "";
  }

  private timeoutMessage(): string {
    return `QwenProxy server did not answer ${this.target.healthUrl} within ${this.readyTimeoutMs} ms.${this.recentOutputBlock()}`;
  }

  private startupFailureMessage(info: ServerExitInfo): string {
    const status = `code ${info.code ?? "null"}${
      info.signal ? `, signal ${info.signal}` : ""
    }`;
    return `QwenProxy server exited during startup (${status}).${this.recentOutputBlock()}`;
  }

  /**
   * Restart the owned child. An external server is probed again and reused
   * when it is still healthy.
   */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * Best-effort synchronous kill for `process.on("exit")`, where async cleanup
   * cannot run. External servers are never signalled.
   */
  stopSync(): void {
    if (!this.child || !this.ownsServer) return;
    try {
      this.child.kill("SIGTERM");
    } catch {}
  }

  /**
   * Gracefully stop a child owned by this manager. External servers are never
   * signalled. Idempotent.
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.ownsServer = false;
      return;
    }

    this.expectedExit = true;
    const exited = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("exit", finish);
      setTimeout(finish, this.stopTimeoutMs + 1_000).unref?.();
    });

    try {
      child.kill("SIGTERM");
    } catch {}

    await Promise.race([exited, this.sleepImpl(this.stopTimeoutMs)]);

    if (this.child === child && this.running) {
      this.recordLine("[gui] Server did not stop in time; forcing termination.");
      try {
        child.kill("SIGKILL");
      } catch {}
      await Promise.race([exited, this.sleepImpl(1_000)]);
    }

    if (this.child === child) {
      this.child = null;
      this.running = false;
      this.ownsServer = false;
      this.expectedExit = false;
    }
  }
}
