import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");

const ROOTS = ["src", "scripts", "bin"];
const EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs"]);
const CALL = /\b(?:spawn|spawnSync|execFileSync|execSync|execFile)\s*\(/;
const LOOKAHEAD = 16;

function listSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      listSourceFiles(absolute, files);
      continue;
    }
    if (EXTENSIONS.has(path.extname(entry.name))) files.push(absolute);
  }
  return files;
}

test("Principle X: every child process is spawned hidden", () => {
  const offenders: string[] = [];

  for (const relativeRoot of ROOTS) {
    const absoluteRoot = path.join(root, relativeRoot);
    if (!fs.existsSync(absoluteRoot)) continue;

    for (const file of listSourceFiles(absoluteRoot)) {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (!CALL.test(line)) continue;
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        const window = lines.slice(index, index + LOOKAHEAD).join("\n");
        if (!window.includes("windowsHide")) {
          offenders.push(
            `${path.relative(root, file).replace(/\\/g, "/")}:${index + 1}`,
          );
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `child processes must pass windowsHide: true (principle X): ${offenders.join(", ")}`,
  );
});
