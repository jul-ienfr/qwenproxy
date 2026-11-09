/**
 * Build and runtime metadata for release verification.
 *
 * The release pipeline injects the version, commit and build date with
 * esbuild/Bun `--define`. Source checkouts fall back to `package.json` and
 * `git`, so `--version` is still useful during development.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

declare const __QWENPROXY_VERSION__: string | undefined;
declare const __QWENPROXY_COMMIT__: string | undefined;
declare const __QWENPROXY_BUILD_DATE__: string | undefined;
declare const __QWENPROXY_STANDALONE__: boolean | undefined;

export interface BuildMetadata {
  /** Semantic version without the leading `v`. */
  version: string;
  commit: string;
  buildDate: string | null;
  standalone: boolean;
  runtime: "bun" | "node";
  platform: NodeJS.Platform;
  arch: string;
}

let cached: BuildMetadata | null = null;

function definedVersion(): string | undefined {
  return typeof __QWENPROXY_VERSION__ !== "undefined"
    ? __QWENPROXY_VERSION__
    : undefined;
}

function definedCommit(): string | undefined {
  return typeof __QWENPROXY_COMMIT__ !== "undefined"
    ? __QWENPROXY_COMMIT__
    : undefined;
}

function definedBuildDate(): string | undefined {
  return typeof __QWENPROXY_BUILD_DATE__ !== "undefined"
    ? __QWENPROXY_BUILD_DATE__
    : undefined;
}

export function isStandaloneBuild(): boolean {
  return typeof __QWENPROXY_STANDALONE__ !== "undefined"
    ? Boolean(__QWENPROXY_STANDALONE__)
    : false;
}

function readPackageVersion(): string | undefined {
  const candidates: string[] = [];
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(currentDir, "../../package.json"));
    candidates.push(path.resolve(currentDir, "../package.json"));
  } catch {}
  candidates.push(path.resolve(process.cwd(), "package.json"));

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8"));
      if (parsed && typeof parsed.version === "string" && parsed.version) {
        return parsed.version;
      }
    } catch {}
  }
  return undefined;
}

function gitCommit(): string | undefined {
  const envCommit =
    process.env.QWENPROXY_BUILD_COMMIT ||
    process.env.GIT_COMMIT ||
    process.env.GITHUB_SHA;
  if (envCommit) return envCommit.slice(0, 12);

  try {
    const output = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    });
    const commit = output.trim();
    return commit || undefined;
  } catch {
    return undefined;
  }
}

function resolveBuildDate(): string | null {
  const defined = definedBuildDate();
  if (defined) return defined;

  const explicit = process.env.QWENPROXY_BUILD_DATE;
  if (explicit) return explicit;

  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch) {
    const seconds = Number(epoch);
    if (Number.isFinite(seconds)) {
      return new Date(seconds * 1000).toISOString();
    }
  }
  return null;
}

export function getBuildMetadata(): BuildMetadata {
  if (cached) return cached;

  const runtime: "bun" | "node" =
    typeof process.versions.bun === "string" ? "bun" : "node";

  cached = {
    version: definedVersion() || readPackageVersion() || "0.0.0",
    commit: definedCommit() || gitCommit() || "unknown",
    buildDate: resolveBuildDate(),
    standalone: isStandaloneBuild(),
    runtime,
    platform: process.platform,
    arch: process.arch,
  };
  return cached;
}

/**
 * Backwards-compatible helper used by the startup banner and admin UI.
 * Returns the version with the leading `v` (for example `v1.6.11`).
 */
export function getAppVersion(): string {
  return `v${getBuildMetadata().version}`;
}

/** One-line output for `--version` / `-v`. */
export function formatVersionLine(): string {
  const meta = getBuildMetadata();
  const details: string[] = [];
  if (meta.commit && meta.commit !== "unknown") {
    details.push(`commit ${meta.commit}`);
  }
  if (meta.buildDate) {
    details.push(`built ${meta.buildDate}`);
  }
  if (meta.standalone) {
    details.push(`${meta.platform}-${meta.arch}`);
  }
  const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  return `QwenProxy v${meta.version}${suffix}`;
}
