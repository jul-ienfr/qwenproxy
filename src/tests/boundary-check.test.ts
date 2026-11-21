import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

interface BoundaryReport {
  total: number;
  known: number;
  fresh: Array<{ edge: string; why: string }>;
  stale: string[];
  cycles: {
    total: number;
    known: number;
    fresh: string[];
    stale: string[];
  };
}

function runChecker(): BoundaryReport {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "check-boundaries.mjs"), "--json"],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  assert.equal(
    result.status,
    0,
    `boundary check must pass: ${result.stdout}${result.stderr}`,
  );
  return JSON.parse(result.stdout) as BoundaryReport;
}

test("boundaries: no forbidden import edge outside the tracked baseline", () => {
  const report = runChecker();
  assert.equal(
    report.fresh.length,
    0,
    `new forbidden edges:\n${report.fresh.map((v) => `  ${v.edge} (${v.why})`).join("\n")}`,
  );
});

test("boundaries: the tracked baseline cannot grow silently", () => {
  const report = runChecker();
  assert.equal(
    report.known,
    0,
    "the allowlist is empty: any new forbidden edge must be fixed, not declared",
  );
  assert.equal(
    report.stale.length,
    0,
    `stale allowlist entries must be removed: ${report.stale.join(", ")}`,
  );
});

test("boundaries: import cycles are tracked and cannot grow silently", () => {
  const report = runChecker();
  assert.equal(
    report.cycles.fresh.length,
    0,
    `new import cycles:\n${report.cycles.fresh.map((c) => `  ${c}`).join("\n")}`,
  );
  assert.equal(
    report.cycles.total,
    2,
    "the cycle baseline is pinned: closing or opening a cycle must update this test deliberately",
  );
  assert.equal(
    report.cycles.stale.length,
    0,
    `stale cycle entries must be removed: ${report.cycles.stale.join(", ")}`,
  );
});
