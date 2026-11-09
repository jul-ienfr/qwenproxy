/**
 * Shared build metadata for the esbuild and standalone pipelines.
 *
 * Release builds set QWENPROXY_BUILD_COMMIT and SOURCE_DATE_EPOCH so the same
 * tagged commit produces byte-identical JavaScript and binary metadata.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const BUILD_META_FILE = "build-meta.json";

function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    }).trim();
  } catch {
    return "";
  }
}

export function collectBuildMetadata(options = {}) {
  const root = options.root || process.cwd();
  const env = options.env || process.env;
  const now = options.now || new Date();
  const pkg =
    options.packageJson ||
    JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));

  const version = String(env.QWENPROXY_VERSION || pkg.version || "0.0.0");
  const commit = String(
    env.QWENPROXY_BUILD_COMMIT ||
      env.GIT_COMMIT ||
      env.GITHUB_SHA ||
      git(root, ["rev-parse", "--short=12", "HEAD"]) ||
      "unknown",
  ).slice(0, 12);

  let buildDate = env.QWENPROXY_BUILD_DATE || "";
  if (!buildDate && env.SOURCE_DATE_EPOCH) {
    const seconds = Number(env.SOURCE_DATE_EPOCH);
    if (Number.isFinite(seconds)) {
      buildDate = new Date(seconds * 1000).toISOString();
    }
  }
  if (!buildDate) buildDate = now.toISOString();

  return {
    version,
    commit,
    buildDate,
    runtime: process.versions.bun ? "bun" : "node",
    node: process.version,
    bun: process.versions.bun || null,
    platform: process.platform,
    arch: process.arch,
  };
}

export function writeBuildMeta(dir, meta) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, BUILD_META_FILE);
  fs.writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
  return file;
}

/** Defines consumed by src/core/build-info.ts. */
export function buildDefines(meta, standalone) {
  return {
    __QWENPROXY_VERSION__: JSON.stringify(meta.version),
    __QWENPROXY_COMMIT__: JSON.stringify(meta.commit),
    __QWENPROXY_BUILD_DATE__: JSON.stringify(meta.buildDate),
    __QWENPROXY_STANDALONE__: JSON.stringify(Boolean(standalone)),
  };
}

/** Bun's --windows-version flag expects four numeric components. */
export function windowsFileVersion(version) {
  const parts = String(version)
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part) && part >= 0)
    .slice(0, 4);
  while (parts.length < 4) parts.push(0);
  return parts.join(".");
}
