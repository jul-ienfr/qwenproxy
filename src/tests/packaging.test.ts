import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  formatVersionLine,
  getAppVersion,
  getBuildMetadata,
  isStandaloneBuild,
} from "../core/build-info.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..", "..");
const scriptsDir = path.join(packageRoot, "scripts");

async function loadScript(name: string): Promise<any> {
  // The scripts are plain ESM outside the TypeScript rootDir, so resolve them
  // dynamically to avoid pulling untyped JavaScript into the typecheck.
  return import(pathToFileURL(path.join(scriptsDir, name)).href);
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-pkg-test-"));
  try {
    fn(dir);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

test("Packaging: source build metadata matches package.json", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"),
  );
  const meta = getBuildMetadata();

  assert.equal(meta.version, pkg.version);
  assert.equal(meta.runtime, "node");
  assert.equal(meta.platform, process.platform);
  assert.equal(meta.arch, process.arch);
  assert.equal(meta.standalone, false);
  assert.equal(isStandaloneBuild(), false);
  assert.equal(getAppVersion(), `v${pkg.version}`);

  const line = formatVersionLine();
  assert.ok(line.startsWith(`QwenProxy v${pkg.version}`));
  if (meta.commit !== "unknown") {
    assert.ok(line.includes(`commit ${meta.commit}`));
  }
});

test("Packaging: build-meta collects deterministic version, commit and date", async () => {
  const { collectBuildMetadata, buildDefines, windowsFileVersion } =
    await loadScript("build-meta.mjs");

  const meta = collectBuildMetadata({
    root: packageRoot,
    packageJson: { version: "9.8.7" },
    env: {
      QWENPROXY_BUILD_COMMIT: "abcdef0123456789",
      SOURCE_DATE_EPOCH: "1700000000",
    },
    now: new Date("2030-01-01T00:00:00.000Z"),
  });

  assert.equal(meta.version, "9.8.7");
  assert.equal(meta.commit, "abcdef012345");
  assert.equal(meta.buildDate, new Date(1700000000 * 1000).toISOString());

  const defines = buildDefines(meta, true);
  assert.equal(defines.__QWENPROXY_VERSION__, JSON.stringify("9.8.7"));
  assert.equal(defines.__QWENPROXY_COMMIT__, JSON.stringify("abcdef012345"));
  assert.equal(
    defines.__QWENPROXY_BUILD_DATE__,
    JSON.stringify(new Date(1700000000 * 1000).toISOString()),
  );
  assert.equal(defines.__QWENPROXY_STANDALONE__, "true");

  assert.equal(windowsFileVersion("1.6.11"), "1.6.11.0");
  assert.equal(windowsFileVersion("v2.0.0-beta.1"), "2.0.0.1");
});

test("Packaging: build-meta prefers explicit build date over SOURCE_DATE_EPOCH", async () => {
  const { collectBuildMetadata } = await loadScript("build-meta.mjs");

  const meta = collectBuildMetadata({
    root: packageRoot,
    packageJson: { version: "1.0.0" },
    env: {
      QWENPROXY_BUILD_COMMIT: "unknown",
      QWENPROXY_BUILD_DATE: "2026-11-08T12:00:00.000Z",
      SOURCE_DATE_EPOCH: "1700000000",
    },
  });

  assert.equal(meta.commit, "unknown");
  assert.equal(meta.buildDate, "2026-11-08T12:00:00.000Z");
});

test("Packaging: writeBuildMeta writes build-meta.json into the target directory", async () => {
  const { writeBuildMeta, BUILD_META_FILE } = await loadScript("build-meta.mjs");

  withTempDir((dir) => {
    const meta = {
      version: "1.2.3",
      commit: "deadbeefcafe",
      buildDate: "2026-11-08T12:00:00.000Z",
    };
    const file = writeBuildMeta(dir, meta);

    assert.equal(file, path.join(dir, BUILD_META_FILE));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), meta);
  });
});

test("Packaging: checksums writes and verifies SHA256SUMS", async () => {
  const {
    collectChecksums,
    formatChecksums,
    sha256File,
    verifyChecksums,
    writeChecksums,
  } = await loadScript("checksums.mjs");

  withTempDir((dir) => {
    const binary = path.join(dir, "qwenproxy-windows-x64.exe");
    fs.writeFileSync(binary, "abc");
    fs.writeFileSync(path.join(dir, "notes.txt"), "ignored");
    fs.writeFileSync(path.join(dir, "build-meta.json"), "{}");

    assert.equal(
      sha256File(binary),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );

    const entries = collectChecksums(dir);
    assert.deepEqual(
      entries.map((entry: { file: string }) => entry.file),
      ["qwenproxy-windows-x64.exe"],
    );

    writeChecksums(dir);
    const sums = fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf-8");
    assert.equal(sums, formatChecksums(entries));
    assert.match(sums, /^[a-f0-9]{64} {2}qwenproxy-windows-x64\.exe\n$/);

    const verified = verifyChecksums(dir);
    assert.equal(verified.ok, true);
    assert.equal(verified.checked, 1);

    fs.appendFileSync(binary, "tampered");
    const tampered = verifyChecksums(dir);
    assert.equal(tampered.ok, false);
    assert.equal(tampered.failures[0].file, "qwenproxy-windows-x64.exe");
    assert.match(tampered.failures[0].reason, /expected .* got/);
  });
});

test("Packaging: checksum verification reports missing and malformed entries", async () => {
  const { verifyChecksums } = await loadScript("checksums.mjs");

  withTempDir((dir) => {
    const missing = "a".repeat(64);
    fs.writeFileSync(
      path.join(dir, "SHA256SUMS"),
      `${missing}  missing.bin\nnot-a-checksum\n`,
    );

    const result = verifyChecksums(dir);
    assert.equal(result.ok, false);
    assert.equal(result.checked, 1);
    assert.deepEqual(
      result.failures.map((failure: { file: string; reason: string }) => failure.file),
      ["missing.bin", "not-a-checksum"],
    );
    assert.equal(result.failures[0].reason, "missing file");
    assert.equal(result.failures[1].reason, "malformed checksum line");
  });
});

test("Packaging: checksum output name can be customized", async () => {
  const { writeChecksums, verifyChecksums } = await loadScript("checksums.mjs");

  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, "asset.bin"), "payload");
    writeChecksums(dir, { output: "ASSETS.sha256" });
    assert.ok(fs.existsSync(path.join(dir, "ASSETS.sha256")));
    assert.equal(verifyChecksums(dir, { output: "ASSETS.sha256" }).ok, true);
  });
});

test("Packaging: build-standalone help and target validation do not build", () => {
  const help = spawnSync(
    process.execPath,
    [path.join(scriptsDir, "build-standalone.mjs"), "--help"],
    { encoding: "utf-8" },
  );
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes("win-x64"));
  assert.ok(help.stdout.includes("linux-arm64"));

  const invalid = spawnSync(
    process.execPath,
    [path.join(scriptsDir, "build-standalone.mjs"), "--target=bogus"],
    { encoding: "utf-8" },
  );
  assert.equal(invalid.status, 1);
  assert.ok(invalid.stderr.includes("Unknown target 'bogus'"));
});

test("Packaging: checksums CLI writes and verifies a directory", () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, "asset.bin"), "payload");
    const write = spawnSync(
      process.execPath,
      [path.join(scriptsDir, "checksums.mjs"), dir],
      { encoding: "utf-8" },
    );
    assert.equal(write.status, 0);
    assert.match(write.stdout, /Wrote .*SHA256SUMS \(1 file\(s\)\)/);

    const verify = spawnSync(
      process.execPath,
      [path.join(scriptsDir, "checksums.mjs"), dir, "--verify"],
      { encoding: "utf-8" },
    );
    assert.equal(verify.status, 0);
    assert.match(verify.stdout, /OK: 1 file\(s\) match SHA256SUMS/);
  });
});

test("Packaging: checksum digest helper is stable across buffer sizes", async () => {
  const { sha256File } = await loadScript("checksums.mjs");
  withTempDir((dir) => {
    const payload = crypto.randomBytes(1024 * 128);
    const file = path.join(dir, "large.bin");
    fs.writeFileSync(file, payload);
    assert.equal(
      sha256File(file),
      crypto.createHash("sha256").update(payload).digest("hex"),
    );
  });
});
