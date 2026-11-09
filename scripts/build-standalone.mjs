#!/usr/bin/env node
/**
 * Build standalone executables with Bun.
 *
 * Bun embeds the JavaScript application and its runtime. Patchright's Chromium
 * stays external, matching the documented browser install step.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  collectBuildMetadata,
  windowsFileVersion,
  writeBuildMeta,
} from "./build-meta.mjs";
import { writeChecksums } from "./checksums.mjs";

const TARGETS = {
  "win-x64": {
    bunTarget: "bun-windows-x64",
    fileName: "qwenproxy-windows-x64.exe",
    windows: true,
    sqlitePrebuild: "win32-x64.node",
  },
  "linux-x64": {
    bunTarget: "bun-linux-x64",
    fileName: "qwenproxy-linux-x64",
    sqlitePrebuild: "linux-x64.node",
  },
  "linux-arm64": {
    bunTarget: "bun-linux-arm64",
    fileName: "qwenproxy-linux-arm64",
    sqlitePrebuild: "linux-arm64.node",
  },
};

function parseArgs(argv) {
  const options = {
    targets: [],
    outdir: "dist/standalone",
    checksums: true,
    help: false,
  };
  for (const arg of argv) {
    if (arg === "--all") options.targets = Object.keys(TARGETS);
    else if (arg === "--no-checksums") options.checksums = false;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--target=")) options.targets.push(arg.slice(9));
    else if (arg.startsWith("--outdir=")) options.outdir = arg.slice(9);
    else if (arg.startsWith("--target")) {
      const value = arg.slice(8).replace(/^=/, "");
      if (value) options.targets.push(value);
    } else if (arg.startsWith("--outdir")) {
      const value = arg.slice(8).replace(/^=/, "");
      if (value) options.outdir = value;
    }
  }
  if (options.targets.length === 0) options.targets = Object.keys(TARGETS);
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/build-standalone.mjs [options]

Options:
  --target=<name>   Build one target (win-x64, linux-x64, linux-arm64)
  --all             Build every target (default)
  --outdir=<dir>    Output directory (default: dist/standalone)
  --no-checksums    Do not write SHA256SUMS
  -h, --help        Show this help

Requires Bun >= 1.2 on PATH (https://bun.sh). Set BUN_BIN to override the
Bun executable path (for example npm's PowerShell shim on Windows).
`);
}

function resolveBun() {
  // BUN_BIN covers wrappers (npm's PowerShell shims) and CI setups where the
  // executable is not named exactly bun/bun.exe on PATH.
  if (process.env.BUN_BIN) return process.env.BUN_BIN;
  return process.platform === "win32" ? "bun.exe" : "bun";
}

function assertBun() {
  const bun = resolveBun();
  const probe = spawnSync(bun, ["--version"], { encoding: "utf-8" });
  if (probe.error || probe.status !== 0) {
    throw new Error(
      "Bun is required to build standalone binaries. Install it from https://bun.sh and retry.",
    );
  }
  return bun;
}

/**
 * Playwright reads `package.json` and `browsers.json` from its package root at
 * module initialization. In a Bun standalone executable the package root lives
 * inside the read-only `$bunfs` virtual filesystem and those runtime reads fail
 * with `Cannot find package 'package.json'`. Inline the two metadata files into
 * the bundled Playwright code for the duration of the build.
 *
 * The patch is applied to node_modules only and restored in `finally`.
 */
function patchPlaywrightMetadata(root) {
  const packageRoot = path.join(root, "node_modules", "patchright-core");
  if (!fs.existsSync(packageRoot)) return () => {};

  const packageJsonPath = path.join(packageRoot, "package.json");
  const browsersJsonPath = path.join(packageRoot, "browsers.json");
  if (!fs.existsSync(packageJsonPath) || !fs.existsSync(browsersJsonPath)) {
    throw new Error(
      "patchright-core is missing package.json or browsers.json; reinstall dependencies.",
    );
  }

  const packageJson = fs.readFileSync(packageJsonPath, "utf-8");
  const browsersJson = fs.readFileSync(browsersJsonPath, "utf-8");
  const files = [
    path.join(packageRoot, "lib", "coreBundle.js"),
    path.join(packageRoot, "lib", "package.js"),
    path.join(packageRoot, "lib", "serverRegistry.js"),
  ];
  const originals = new Map();
  let replacements = 0;

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const original = fs.readFileSync(file, "utf-8");
    let source = original;

    // Preserve the original declaration form: top-level `const`/`var` stays,
    // while assignments inside an `__esm` init closure must not redeclare and
    // shadow the module-level binding the rest of the bundle reads.
    source = source.replace(
      /((?:var|const|let)[ \t]+)?packageJSON[ \t]*=[ \t]*require\([^;]*?"package\.json"[^;]*?\);/g,
      (_match, prefix = "") => `${prefix}packageJSON = ${packageJson};`,
    );
    source = source.replace(
      /((?:var|const|let)[ \t]+)?registry[ \t]*=[ \t]*new Registry\(require\([^;]*?"browsers\.json"[^;]*?\)\);/g,
      (_match, prefix = "") => `${prefix}registry = new Registry(${browsersJson});`,
    );

    if (source !== original) {
      originals.set(file, original);
      fs.writeFileSync(file, source, "utf-8");
      replacements += 1;
    }
  }

  if (replacements === 0) {
    throw new Error(
      "Unable to inline patchright-core metadata: unsupported patchright-core layout.",
    );
  }

  return () => {
    for (const [file, original] of originals) {
      fs.writeFileSync(file, original, "utf-8");
    }
  };
}

/**
 * `better-sqlite3` resolves its native addon at runtime through `fs.existsSync`
 * and a dynamic `require`, which Bun cannot statically embed into a standalone
 * executable. Point the package entry at the prebuilt addon for the build
 * target instead, so Bun embeds the matching `.node` file.
 *
 * Cross-compilation therefore works: the package ships prebuilds for every
 * target, and we select the one that matches the executable being produced.
 */
function patchSqliteBinding(root, target) {
  const sqliteRoot = path.join(root, "node_modules", "better-sqlite3");
  const indexFile = path.join(sqliteRoot, "lib", "index.js");
  const prebuild = path.join(sqliteRoot, "prebuilds", target.sqlitePrebuild);
  if (!fs.existsSync(indexFile) || !fs.existsSync(prebuild)) {
    throw new Error(
      `better-sqlite3 is missing ${target.sqlitePrebuild}; reinstall dependencies.`,
    );
  }

  const original = fs.readFileSync(indexFile, "utf-8");
  const patched = [
    '"use strict";',
    `module.exports = require("./database")(() => require("../prebuilds/${target.sqlitePrebuild}"), false);`,
    'module.exports.SqliteError = require("./sqlite-error");',
    "",
  ].join("\n");
  fs.writeFileSync(indexFile, patched, "utf-8");

  return () => {
    fs.writeFileSync(indexFile, original, "utf-8");
  };
}

function buildTarget({ bun, root, meta, outdir, name, target }) {
  const outfile = path.join(outdir, target.fileName);
  const args = [
    "build",
    "--compile",
    `--target=${target.bunTarget}`,
    // Bun's CLI accepts `--define NAME=VALUE`; the `--define:NAME=VALUE` form
    // is silently ignored by the current release.
    "--define",
    `__QWENPROXY_VERSION__=${JSON.stringify(meta.version)}`,
    "--define",
    `__QWENPROXY_COMMIT__=${JSON.stringify(meta.commit)}`,
    "--define",
    `__QWENPROXY_BUILD_DATE__=${JSON.stringify(meta.buildDate)}`,
    "--define",
    "__QWENPROXY_STANDALONE__=true",
    // Optional Patchright imports are guarded at runtime; Bun cannot resolve
    // them because they are not installed in every environment.
    "--external",
    "proxy-agent",
    "--external",
    "chromium-bidi",
    // Keep .env discovery deterministic (executable dir, cwd, data dir).
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
  ];

  if (target.windows) {
    args.push(
      "--windows-title=QwenProxy",
      "--windows-description=OpenAI, Anthropic and Gemini compatible gateway for Qwen",
      `--windows-version=${windowsFileVersion(meta.version)}`,
    );
  }

  args.push("--outfile", outfile, "src/index.ts");

  console.log(`[standalone] Building ${name} -> ${path.relative(root, outfile)}`);
  const restoreSqlite = patchSqliteBinding(root, target);
  try {
    const result = spawnSync(bun, args, { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Bun build failed for ${name} (exit ${result.status})`);
    }
  } finally {
    restoreSqlite();
  }
  if (!fs.existsSync(outfile)) {
    throw new Error(`Bun did not produce ${outfile}`);
  }

  const size = fs.statSync(outfile).size;
  console.log(
    `[standalone] ${name}: ${(size / (1024 * 1024)).toFixed(1)} MiB`,
  );
  return outfile;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  for (const name of options.targets) {
    if (!TARGETS[name]) {
      throw new Error(
        `Unknown target '${name}'. Expected one of: ${Object.keys(TARGETS).join(", ")}`,
      );
    }
  }

  const root = process.cwd();
  const outdir = path.resolve(root, options.outdir);
  fs.mkdirSync(outdir, { recursive: true });

  const meta = collectBuildMetadata({ root });
  const bun = assertBun();

  // Playwright reads package.json/browsers.json at module init; inline them
  // while Bun bundles, then restore node_modules exactly as it was.
  const restorePlaywrightMetadata = patchPlaywrightMetadata(root);
  let built;
  try {
    built = options.targets.map((name) =>
      buildTarget({ bun, root, meta, outdir, name, target: TARGETS[name] }),
    );
  } finally {
    restorePlaywrightMetadata();
  }

  writeBuildMeta(outdir, meta);
  if (options.checksums) {
    writeChecksums(outdir);
  }

  console.log(
    `[standalone] QwenProxy v${meta.version} (${meta.commit}) -> ${path.relative(root, outdir)}`,
  );
  console.log(
    `[standalone] Built: ${built.map((file) => path.basename(file)).join(", ")}`,
  );
}

try {
  main();
} catch (error) {
  console.error(
    `[standalone] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
