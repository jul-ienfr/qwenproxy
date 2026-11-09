#!/usr/bin/env node
/**
 * SHA256SUMS generation and verification for release assets.
 *
 * Usage:
 *   node scripts/checksums.mjs [dir] [--output SHA256SUMS]
 *   node scripts/checksums.mjs [dir] --verify [--output SHA256SUMS]
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BUILD_META_FILE } from "./build-meta.mjs";

const DEFAULT_OUTPUT = "SHA256SUMS";
const IGNORED_SUFFIXES = [".json", ".sha256", ".sig", ".txt"];

export function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

export function listArtifacts(dir, options = {}) {
  const output = options.output || DEFAULT_OUTPUT;
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name !== output)
    .filter((name) => name !== BUILD_META_FILE)
    .filter((name) => !name.startsWith("."))
    .filter(
      (name) => !IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix)),
    );
  return entries.sort();
}

export function collectChecksums(dir, options = {}) {
  return listArtifacts(dir, options).map((name) => ({
    file: name,
    sha256: sha256File(path.join(dir, name)),
  }));
}

export function formatChecksums(entries) {
  return `${entries
    .map((entry) => `${entry.sha256}  ${entry.file}`)
    .join("\n")}\n`;
}

export function writeChecksums(dir, options = {}) {
  const output = options.output || DEFAULT_OUTPUT;
  const entries = collectChecksums(dir, { output });
  fs.writeFileSync(path.join(dir, output), formatChecksums(entries), "utf-8");
  return entries;
}

export function verifyChecksums(dir, options = {}) {
  const output = options.output || DEFAULT_OUTPUT;
  const checksumPath = path.join(dir, output);
  const raw = fs.readFileSync(checksumPath, "utf-8");
  const failures = [];
  let checked = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(trimmed);
    if (!match) {
      failures.push({ file: trimmed, reason: "malformed checksum line" });
      continue;
    }
    const expected = match[1].toLowerCase();
    const name = match[2];
    const target = path.join(dir, name);
    checked += 1;
    if (!fs.existsSync(target)) {
      failures.push({ file: name, reason: "missing file" });
      continue;
    }
    const actual = sha256File(target);
    if (actual !== expected) {
      failures.push({
        file: name,
        reason: `expected ${expected}, got ${actual}`,
      });
    }
  }

  return { ok: failures.length === 0, checked, failures };
}

function parseArgs(argv) {
  const options = { dir: "dist/standalone", output: DEFAULT_OUTPUT, verify: false };
  for (const arg of argv) {
    if (arg === "--verify") options.verify = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--output=")) options.output = arg.slice(9);
    else if (arg.startsWith("--output")) options.output = arg.slice(8) || DEFAULT_OUTPUT;
    else if (!arg.startsWith("-")) options.dir = arg;
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/checksums.mjs [dir] [options]

Options:
  --output NAME   Checksum file name (default: ${DEFAULT_OUTPUT})
  --verify        Verify an existing checksum file instead of writing one
  -h, --help      Show this help
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!fs.existsSync(options.dir)) {
    console.error(`[checksums] Directory not found: ${options.dir}`);
    process.exitCode = 1;
    return;
  }

  if (options.verify) {
    const result = verifyChecksums(options.dir, { output: options.output });
    if (result.ok) {
      console.log(
        `[checksums] OK: ${result.checked} file(s) match ${options.output}`,
      );
      return;
    }
    for (const failure of result.failures) {
      console.error(`[checksums] FAILED ${failure.file}: ${failure.reason}`);
    }
    process.exitCode = 1;
    return;
  }

  const entries = writeChecksums(options.dir, { output: options.output });
  console.log(
    `[checksums] Wrote ${path.join(options.dir, options.output)} (${entries.length} file(s))`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`[checksums] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
