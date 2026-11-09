import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  resolveServerCommand,
  resolveServerTarget,
  ServerManager,
  type ManagedChild,
  type ServerCommand,
} from "../gui/server-manager.ts";

class MockChild extends EventEmitter implements ManagedChild {
  readonly pid = 4242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: Array<string | number> = [];
  alive = true;
  constructor(private readonly exitOnKill = true) {
    super();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal ?? "SIGTERM");
    this.alive = false;
    if (this.exitOnKill) {
      queueMicrotask(() => this.emit("exit", 0, signal ?? "SIGTERM"));
    }
    return true;
  }
}

function response(status: number): Response {
  return { status } as Response;
}

const baseCommand: ServerCommand = {
  command: process.execPath,
  args: ["server.js"],
};

test("ServerManager: wildcard hosts resolve to loopback for the GUI", () => {
  const wildcard = resolveServerTarget("0.0.0.0", 7936);
  assert.equal(wildcard.host, "127.0.0.1");
  assert.equal(wildcard.dashboardUrl, "http://127.0.0.1:7936/admin");
  assert.equal(wildcard.healthUrl, "http://127.0.0.1:7936/health");

  const ipv6Wildcard = resolveServerTarget("::", 7936);
  assert.equal(ipv6Wildcard.host, "127.0.0.1");

  const ipv6Loopback = resolveServerTarget("::1", 7936);
  assert.equal(ipv6Loopback.origin, "http://[::1]:7936");

  const localhost = resolveServerTarget("localhost", 3000);
  assert.equal(localhost.dashboardUrl, "http://localhost:3000/admin");
});

test("ServerManager: resolveServerCommand prefers a built dist entrypoint", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qpx-gui-dist-"));
  try {
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "index.js"), "");
    const command = resolveServerCommand({
      packageRoot: root,
      execPath: "node.exe",
      tsxLoader: null,
    });
    assert.equal(command.command, "node.exe");
    assert.deepEqual(command.args, [path.join(root, "dist", "index.js")]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ServerManager: resolveServerCommand falls back to the tsx loader", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qpx-gui-src-"));
  try {
    const command = resolveServerCommand({
      packageRoot: root,
      execPath: "node.exe",
      tsxLoader: "/opt/tsx/loader.mjs",
    });
    assert.equal(command.command, "node.exe");
    assert.equal(command.args[0], "--import");
    assert.ok(command.args[1]!.endsWith("loader.mjs"));
    assert.ok(command.args[2]!.endsWith(path.join("src", "index.ts")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ServerManager: reuses a healthy server without spawning", async () => {
  let spawns = 0;
  const manager = new ServerManager({
    target: resolveServerTarget("127.0.0.1", 7936),
    command: baseCommand,
    fetch: async () => response(200),
    spawn: () => {
      spawns += 1;
      throw new Error("should not spawn");
    },
  });

  await manager.start();
  assert.equal(spawns, 0);
  assert.equal(manager.ownsServerProcess, false);
});

test("ServerManager: spawns and waits for health", async () => {
  const child = new MockChild();
  let spawns = 0;
  let probes = 0;
  const manager = new ServerManager({
    target: resolveServerTarget("127.0.0.1", 7936),
    command: baseCommand,
    fetch: async () => response(probes++ < 2 ? 503 : 200),
    spawn: () => {
      spawns += 1;
      return child;
    },
    sleep: async () => {},
    now: () => 0,
  });

  await manager.start();
  assert.equal(spawns, 1);
  assert.equal(probes, 3);
  assert.equal(manager.isRunning, true);
  assert.equal(manager.ownsServerProcess, true);
});

test("ServerManager: fails fast when the child exits during startup", async () => {
  const child = new MockChild();
  const manager = new ServerManager({
    target: resolveServerTarget("127.0.0.1", 7936),
    command: baseCommand,
    fetch: async () => response(503),
    spawn: () => {
      queueMicrotask(() => child.stderr.write("No Qwen accounts configured\n"));
      queueMicrotask(() => child.emit("exit", 1, null));
      return child;
    },
    sleep: async () => {},
    now: () => 0,
  });

  await assert.rejects(() => manager.start(), /No Qwen accounts configured/);
  assert.equal(manager.isRunning, false);
  assert.equal(manager.ownsServerProcess, false);
});

test("ServerManager: reports a startup timeout with recent output", async () => {
  const child = new MockChild();
  let clock = 0;
  const manager = new ServerManager({
    target: resolveServerTarget("127.0.0.1", 7936),
    command: baseCommand,
    fetch: async () => response(503),
    spawn: () => {
      queueMicrotask(() => child.stderr.write("still warming up\n"));
      return child;
    },
    sleep: async () => {},
    now: () => (clock += 1_000),
    readyTimeoutMs: 1_000,
  });

  await assert.rejects(
    () => manager.start(),
    (error: Error) => {
      assert.match(error.message, /did not answer/);
      assert.match(error.message, /still warming up/);
      return true;
    },
  );
});

test("ServerManager: restart stops the old child and starts a new one", async () => {
  const children: MockChild[] = [];
  let health = false;
  let spawns = 0;
  const manager = new ServerManager({
    target: resolveServerTarget("127.0.0.1", 7936),
    command: baseCommand,
    fetch: async () => response(health ? 200 : 503),
    spawn: () => {
      spawns += 1;
      health = false;
      const child = new MockChild();
      const kill = child.kill.bind(child);
      child.kill = (signal?: NodeJS.Signals | number) => {
        health = false;
        return kill(signal);
      };
      children.push(child);
      return child;
    },
    sleep: async () => {
      // Only a live child can make /health succeed.
      health = children.some((child) => child.alive);
    },
    now: () => 0,
  });

  await manager.start();
  assert.equal(spawns, 1);
  assert.equal(health, true);

  await manager.restart();
  assert.equal(spawns, 2);
  assert.equal(children.length, 2);
  assert.ok(children[0]!.signals.includes("SIGTERM"));
  assert.equal(manager.isRunning, true);
});

test("ServerManager: stop signals only an owned child and clears state", async () => {
  const child = new MockChild();
  let probes = 0;
  const manager = new ServerManager({
    target: resolveServerTarget("127.0.0.1", 7936),
    command: baseCommand,
    fetch: async () => response(probes++ === 0 ? 503 : 200),
    spawn: () => child,
    sleep: async () => {},
    now: () => 0,
  });

  await manager.start();
  assert.equal(manager.ownsServerProcess, true);

  await manager.stop();
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(manager.isRunning, false);
  assert.equal(manager.ownsServerProcess, false);
});

test("ServerManager: stop forces termination when the child ignores SIGTERM", async () => {
  const child = new MockChild(false);
  let probes = 0;
  const manager = new ServerManager({
    target: resolveServerTarget("127.0.0.1", 7936),
    command: baseCommand,
    fetch: async () => response(probes++ === 0 ? 503 : 200),
    spawn: () => child,
    sleep: async () => {},
    now: () => 0,
    stopTimeoutMs: 10,
  });

  await manager.start();
  await manager.stop();
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(manager.isRunning, false);
});

test("ServerManager: stop never signals an external server", async () => {
  const manager = new ServerManager({
    target: resolveServerTarget("127.0.0.1", 7936),
    command: baseCommand,
    fetch: async () => response(200),
    spawn: () => {
      throw new Error("should not spawn");
    },
  });

  await manager.start();
  await manager.stop();
  assert.equal(manager.ownsServerProcess, false);
  assert.equal(manager.isRunning, false);
});

test("ServerManager: bounds captured output while forwarding lines", async () => {
  const child = new MockChild();
  const forwarded: string[] = [];
  let probes = 0;
  const manager = new ServerManager({
    target: resolveServerTarget("127.0.0.1", 7936),
    command: baseCommand,
    fetch: async () => response(probes++ === 0 ? 503 : 200),
    spawn: () => {
      queueMicrotask(() => {
        for (let index = 0; index < 10; index += 1) {
          child.stdout.write(`line-${index}\n`);
        }
      });
      return child;
    },
    sleep: async () => {},
    now: () => 0,
    outputLines: 4,
    logger: {
      info: (line) => forwarded.push(line),
      error: (line) => forwarded.push(line),
    },
  });
  manager.on("output", (line: string) => forwarded.push(line));

  await manager.start();
  assert.ok(manager.recentOutput.length <= 4);
  assert.ok(manager.recentOutput.includes("line-9"));
  assert.ok(forwarded.includes("line-9"));
});
