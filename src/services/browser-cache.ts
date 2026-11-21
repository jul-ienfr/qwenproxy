import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium } from "patchright";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function getDirStats(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  function walk(d: string) {
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile()) {
          try {
            bytes += fs.statSync(full).size;
            files++;
          } catch {}
        }
      }
    } catch {}
  }
  walk(dir);
  return { bytes, files };
}

export async function cleanPlaywrightBrowsers(cleanUnused: boolean): Promise<{
  activeBrowserDir: string | null;
  unusedDirs: { name: string; path: string; size: string; bytes: number }[];
  freedBytes: number;
}> {
  let activeBrowserDir: string | null = null;
  let activeRevision: string | null = null;
  let msPlaywrightDir: string | null = null;

  try {
    const execPath = chromium.executablePath();
    // E.g. C:\Users\...\AppData\Local\ms-playwright\chromium-1234\chrome-win64\chrome.exe
    // The browser folder is the first directory under ms-playwright
    const resolvedPlaywrightDir = path.resolve(execPath, "..", "..", "..");
    const rel = path.relative(resolvedPlaywrightDir, execPath);
    const topFolder = rel.split(path.sep)[0];
    activeBrowserDir = topFolder;
    msPlaywrightDir = resolvedPlaywrightDir;

    const matchRev = topFolder.match(/-(\d+)$/);
    if (matchRev) {
      activeRevision = matchRev[1];
    }
  } catch {}

  if (!msPlaywrightDir || !fs.existsSync(msPlaywrightDir)) {
    const defaultPlaywrightDir =
      process.env.PLAYWRIGHT_BROWSERS_PATH ||
      (process.platform === "win32"
        ? path.join(os.homedir(), "AppData", "Local", "ms-playwright")
        : process.platform === "darwin"
          ? path.join(os.homedir(), "Library", "Caches", "ms-playwright")
          : path.join(os.homedir(), ".cache", "ms-playwright"));
    if (fs.existsSync(defaultPlaywrightDir)) {
      msPlaywrightDir = defaultPlaywrightDir;
    }
  }

  const unusedDirs: { name: string; path: string; size: string; bytes: number }[] = [];
  let freedBytes = 0;

  if (msPlaywrightDir && fs.existsSync(msPlaywrightDir)) {
    try {
      const entries = fs.readdirSync(msPlaywrightDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const folderName = entry.name;

        // Never delete:
        // 1. Exact active browser folder (e.g. chromium-1234)
        if (folderName === activeBrowserDir) continue;

        // 2. Headless shell sharing the active revision (e.g. chromium_headless_shell-1234)
        if (activeRevision && folderName.includes(activeRevision)) continue;

        // 3. System tools and critical link directories
        if (
          folderName.startsWith("winldd") ||
          folderName.startsWith("ffmpeg") ||
          folderName.startsWith(".links") ||
          folderName.startsWith(".registry")
        ) {
          continue;
        }

        const fullPath = path.join(msPlaywrightDir, folderName);
        const { bytes } = getDirStats(fullPath);
        if (bytes > 0) {
          unusedDirs.push({
            name: folderName,
            path: fullPath,
            size: formatBytes(bytes),
            bytes,
          });
        }
      }

      if (cleanUnused && unusedDirs.length > 0) {
        for (const item of unusedDirs) {
          try {
            fs.rmSync(item.path, { recursive: true, force: true });
            freedBytes += item.bytes;
          } catch (err) {
            console.warn(`[CleanCache] Warning: could not remove ${item.name}:`, err);
          }
        }
      }
    } catch (err) {
      console.warn("[CleanCache] Error reading ms-playwright directory:", err);
    }
  }

  return { activeBrowserDir, unusedDirs, freedBytes };
}
