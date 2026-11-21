import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const testsDir = path.join(root, "src", "tests");
const scriptUrl = new URL("../../scripts/run-tests.mjs", import.meta.url).href;

const LIVE = [
  "src/tests/concurrentChat.test.ts",
  "src/tests/agenticStress.test.ts",
];

const ORPHANS = [
  "src/tests/account-proxy.test.ts",
  "src/tests/apply-upstream-usage.test.ts",
  "src/tests/mutex-epoch.test.ts",
  "src/tests/stale-stream-slot-sweeper.test.ts",
  "src/tests/timezone-ascii.test.ts",
  "src/tests/tool-call-heuristics.test.ts",
  "src/tests/user-auth.test.ts",
  "src/tests/user-quota.test.ts",
  "src/tests/users.test.ts",
  "src/tests/users-migration.test.ts",
];

interface RunnerModule {
  getMockTestFiles: () => string[];
  LIVE_TEST_FILES: readonly string[];
  buildTestCommand: (concurrency?: number) => {
    command: string;
    args: string[];
  };
}

async function loadRunner(): Promise<RunnerModule> {
  return (await import(scriptUrl)) as RunnerModule;
}

function allTestFiles(): string[] {
  return fs
    .readdirSync(testsDir)
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `src/tests/${name}`)
    .sort();
}

test("manifest: derived set equals every test file minus the declared live files", async () => {
  const runner = await loadRunner();
  const expected = allTestFiles().filter((file) => !LIVE.includes(file));
  assert.deepEqual(runner.getMockTestFiles(), expected);
  assert.deepEqual([...runner.LIVE_TEST_FILES].sort(), [...LIVE].sort());
  for (const orphan of ORPHANS) {
    assert.ok(
      runner.getMockTestFiles().includes(orphan),
      `orphaned suite must be in the gate: ${orphan}`,
    );
  }
});

test("manifest: a newly created fixture is picked up with no list edit", async () => {
  const runner = await loadRunner();
  const rel = "src/tests/zz-manifest-fixture.test.ts";
  const fixture = path.join(testsDir, "zz-manifest-fixture.test.ts");
  fs.rmSync(fixture, { force: true });
  try {
    assert.ok(!runner.getMockTestFiles().includes(rel));
    fs.writeFileSync(
      fixture,
      'import { test } from "node:test";\ntest("manifest fixture", () => {});\n',
    );
    assert.ok(runner.getMockTestFiles().includes(rel));
  } finally {
    fs.rmSync(fixture, { force: true });
  }
  assert.ok(!runner.getMockTestFiles().includes(rel));
});

test("manifest: the fast variant differs only by concurrency", async () => {
  const runner = await loadRunner();
  const slow = runner.buildTestCommand(1);
  const fast = runner.buildTestCommand(2);
  assert.equal(slow.command, fast.command);
  const normalize = (args: string[]) =>
    args.map((arg) =>
      arg.replace(/^--test-concurrency=\d+$/, "--test-concurrency=N"),
    );
  assert.deepEqual(normalize(slow.args), normalize(fast.args));
  assert.ok(slow.args.includes("--test-concurrency=1"));
  assert.ok(fast.args.includes("--test-concurrency=2"));
  assert.ok(slow.args.includes("--env-file=.env.test"));
});

test("manifest: package scripts use one runner and the default gate is hermetic", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.match(pkg.scripts["test:mock"], /scripts\/run-tests\.mjs/);
  assert.match(pkg.scripts["test:mock:fast"], /scripts\/run-tests\.mjs/);
  assert.doesNotMatch(pkg.scripts["test"], /test:live/);
  assert.equal(pkg.scripts["test"], "npm run test:mock");
  assert.match(pkg.scripts["test:live"], /concurrentChat\.test\.ts/);
  assert.match(pkg.scripts["test:live"], /agenticStress\.test\.ts/);
});
