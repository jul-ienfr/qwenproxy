import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(root, "src", "tests");

export const LIVE_TEST_FILES = Object.freeze([
  "src/tests/concurrentChat.test.ts",
  "src/tests/agenticStress.test.ts",
]);

export function getMockTestFiles() {
  const live = new Set(LIVE_TEST_FILES);
  return fs
    .readdirSync(testsDir)
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `src/tests/${name}`)
    .filter((rel) => !live.has(rel))
    .sort();
}

export function buildTestCommand(concurrency = 1) {
  const level =
    Number.isInteger(concurrency) && concurrency >= 1 ? concurrency : 1;
  return {
    command: process.execPath,
    args: [
      path.join(root, "node_modules", "tsx", "dist", "cli.mjs"),
      "--test",
      `--test-concurrency=${level}`,
      "--env-file=.env.test",
      ...getMockTestFiles(),
    ],
  };
}

function parseConcurrency(argv) {
  for (const arg of argv) {
    const match = /^--concurrency=(\d+)$/.exec(arg);
    if (match) return Number.parseInt(match[1], 10);
  }
  return 1;
}

const invokedEntry = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";

if (import.meta.url === invokedEntry) {
  const { command, args } = buildTestCommand(
    parseConcurrency(process.argv.slice(2)),
  );
  const child = spawn(command, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on("close", (code) => {
    process.exitCode = code ?? 1;
  });
}
