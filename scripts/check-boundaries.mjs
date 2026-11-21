import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const srcDir = path.join(root, "src");

const RULES = [
  {
    from: "core",
    to: ["routes", "tui", "api", "admin", "gui"],
    why: "the domain layer must not depend on presentation or UI",
  },
  {
    from: "utils",
    to: ["core", "services", "tools", "routes", "tui", "api", "admin", "gui"],
    why: "utils must stay a leaf",
  },
  {
    from: "services",
    to: ["root", "routes", "tui", "gui", "admin"],
    why: "the integration layer must not depend on entry points or presentation",
  },
  {
    from: "tools",
    to: ["routes", "tui", "gui", "admin", "api"],
    why: "tools must not depend on transport or UI",
  },
  {
    from: "cache",
    to: ["routes", "tui", "gui", "admin", "api", "services"],
    why: "cache must stay a leaf",
  },
];

// Layer violations: empty. Any new one must be fixed, not declared.
const KNOWN_VIOLATIONS = new Map();

// Import cycles: measured baseline. Layer rules do not detect cycles, so they are
// tracked separately with the reason each one is still open.
const KNOWN_CYCLES = new Map([
  [
    "src/services/auth-playwright.ts | src/services/captcha-coordinator.ts | src/services/media-generation.ts | src/services/qwen-chat-pool.ts | src/services/qwen-file-upload.ts | src/services/qwen-thread-state.ts | src/services/qwen.ts",
    "upstream integration core: shrank from 10 files to 7 and no longer spans layers, but the services still reference each other",
  ],
  [
    "src/services/context-meter.ts | src/services/token-estimation-metrics.ts",
    "context meter reports into token-estimation metrics, which reads the meter back for its snapshot",
  ],
]);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "tests" || entry.name === "benchmarks") continue;
      walk(full, out);
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
}

const files = [];
walk(srcDir, files);

const rel = (p) => path.relative(root, p).split(path.sep).join("/");
const known = new Set(files.map(rel));

function resolve(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [
    base,
    `${base}.ts`,
    path.join(base, "index.ts"),
    base.replace(/\.js$/, ".ts"),
  ]) {
    const candidateRel = rel(candidate);
    if (known.has(candidateRel)) return candidateRel;
  }
  return null;
}

function moduleOf(file) {
  const parts = file.split("/");
  return parts.length === 2 ? "root" : parts[1];
}

const graph = new Map();
for (const file of files) {
  const from = rel(file);
  const text = fs.readFileSync(file, "utf8");
  const specs = [];
  for (const match of text.matchAll(/from\s*['"](\.[^'"]+)['"]/g)) specs.push(match[1]);
  for (const match of text.matchAll(/import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) specs.push(match[1]);
  const deps = new Set();
  for (const spec of specs) {
    const target = resolve(file, spec);
    if (target && target !== from) deps.add(target);
  }
  graph.set(from, [...deps]);
}

const violations = [];
for (const [from, deps] of graph) {
  const fromModule = moduleOf(from);
  for (const target of deps) {
    const toModule = moduleOf(target);
    if (toModule === fromModule) continue;
    for (const rule of RULES) {
      if (rule.from !== fromModule) continue;
      if (!rule.to.includes(toModule)) continue;
      violations.push({ edge: `${from} -> ${target}`, why: rule.why });
    }
  }
}

const seenEdges = new Set();
const uniqueViolations = violations.filter((violation) => {
  if (seenEdges.has(violation.edge)) return false;
  seenEdges.add(violation.edge);
  return true;
});

// Tarjan: strongly connected components of size > 1 are import cycles.
const index = new Map();
const low = new Map();
const onStack = new Set();
const stack = [];
const components = [];
let counter = 0;

function strongconnect(v) {
  index.set(v, counter);
  low.set(v, counter);
  counter++;
  stack.push(v);
  onStack.add(v);
  for (const w of graph.get(v) || []) {
    if (!index.has(w)) {
      strongconnect(w);
      low.set(v, Math.min(low.get(v), low.get(w)));
    } else if (onStack.has(w)) {
      low.set(v, Math.min(low.get(v), index.get(w)));
    }
  }
  if (low.get(v) === index.get(v)) {
    const component = [];
    let w;
    do {
      w = stack.pop();
      onStack.delete(w);
      component.push(w);
    } while (w !== v);
    if (component.length > 1) components.push(component);
  }
}
for (const v of graph.keys()) if (!index.has(v)) strongconnect(v);

const cycleKeys = components.map((component) => component.sort().join(" | "));
const freshCycles = cycleKeys.filter((key) => !KNOWN_CYCLES.has(key));
const staleCycles = [...KNOWN_CYCLES.keys()].filter((key) => !cycleKeys.includes(key));

const freshViolations = uniqueViolations.filter(
  (violation) => !KNOWN_VIOLATIONS.has(violation.edge),
);
const staleViolations = [...KNOWN_VIOLATIONS.keys()].filter(
  (edge) => !uniqueViolations.some((violation) => violation.edge === edge),
);

const json = process.argv.includes("--json");

if (json) {
  console.log(
    JSON.stringify(
      {
        total: uniqueViolations.length,
        known: uniqueViolations.length - freshViolations.length,
        fresh: freshViolations,
        stale: staleViolations,
        cycles: {
          total: cycleKeys.length,
          known: cycleKeys.length - freshCycles.length,
          fresh: freshCycles,
          stale: staleCycles,
        },
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `Forbidden import edges: ${uniqueViolations.length} (known: ${uniqueViolations.length - freshViolations.length})`,
  );
  for (const violation of freshViolations) {
    console.log(`  NEW  ${violation.edge}`);
  }
  for (const edge of staleViolations) {
    console.log(`  STALE allowlist entry (no longer present): ${edge}`);
  }
  console.log(
    `Import cycles: ${cycleKeys.length} (known: ${cycleKeys.length - freshCycles.length})`,
  );
  for (const cycle of freshCycles) {
    console.log(`  NEW CYCLE  ${cycle}`);
  }
  for (const cycle of staleCycles) {
    console.log(`  STALE cycle entry (no longer present): ${cycle}`);
  }
  if (freshViolations.length === 0 && freshCycles.length === 0) {
    console.log("Boundary check PASSED — no new forbidden edge, no new cycle.");
  }
}

process.exitCode = freshViolations.length > 0 || freshCycles.length > 0 ? 1 : 0;
