#!/usr/bin/env node
/**
 * Production bundle build.
 *
 * Replaces the previous raw esbuild CLI so every bundle receives the same
 * version/commit/build-date constants as the standalone binaries.
 */

import path from "node:path";
import { build } from "esbuild";
import {
  buildDefines,
  collectBuildMetadata,
  writeBuildMeta,
} from "./build-meta.mjs";

const root = process.cwd();
const outdir = path.join(root, "dist");
const entryPoints = [
  "src/index.ts",
  "src/sync-clients.ts",
  "src/clean-cache.ts",
  "src/reset-cooldowns.ts",
  "src/delete-chats.ts",
  "src/login.ts",
];

const meta = collectBuildMetadata({ root });

await build({
  absWorkingDir: root,
  entryPoints,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  outdir,
  define: buildDefines(meta, false),
  logLevel: "info",
});

const metaFile = writeBuildMeta(outdir, meta);
console.log(
  `[build] QwenProxy v${meta.version} (${meta.commit}) -> ${path.relative(
    root,
    metaFile,
  )}`,
);
