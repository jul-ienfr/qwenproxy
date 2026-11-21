/**
 * Runtime registry of Qwen model ids that are usable through completions but
 * missing from the account-scoped `/api/models` catalog.
 *
 * Qwen sometimes rolls a model out behind the web UI before exposing it in the
 * catalog (or keeps preview ids out of the catalog entirely). Advertising only
 * the catalog meant such a model worked for clients that already knew its id
 * but never appeared in `/v1/models`.
 *
 * When a completion succeeds for an id that Qwen accepted, the id is recorded
 * here and merged into `/v1/models` from then on. The list is persisted under
 * the data directory so a discovered model stays available across restarts,
 * and entries expire after `DISCOVERED_MODEL_TTL_MS` so removed ids do not
 * accumulate forever.
 */

import fs from "node:fs";
import path from "node:path";
import { getDiscoveredModelsPath } from "./paths.ts";
import { logger } from "./logger.ts";

const MAX_DISCOVERED_MODELS = 200;
const DISCOVERED_MODEL_TTL_MS = 45 * 24 * 60 * 60 * 1000;
const REFRESH_PERSIST_INTERVAL_MS = 60 * 60 * 1000;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

interface PersistedDiscoveredModel {
  id: string;
  lastSeen: string;
}

interface PersistedDiscoveredModels {
  version: 1;
  models: PersistedDiscoveredModel[];
}

let cache: Map<string, number> | null = null;
let cachePath: string | null = null;

function prune(models: Map<string, number>): void {
  const cutoff = Date.now() - DISCOVERED_MODEL_TTL_MS;
  for (const [id, lastSeen] of models) {
    if (lastSeen < cutoff) models.delete(id);
  }
  if (models.size <= MAX_DISCOVERED_MODELS) return;

  const keep = [...models.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, MAX_DISCOVERED_MODELS);
  models.clear();
  for (const [id, lastSeen] of keep) models.set(id, lastSeen);
}

function load(): Map<string, number> {
  const filePath = getDiscoveredModelsPath();
  if (cache && cachePath === filePath) return cache;

  const models = new Map<string, number>();
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf8"),
    ) as Partial<PersistedDiscoveredModels>;
    if (Array.isArray(parsed.models)) {
      for (const entry of parsed.models) {
        if (
          !entry ||
          typeof entry.id !== "string" ||
          !MODEL_ID_PATTERN.test(entry.id)
        ) {
          continue;
        }
        const lastSeen =
          typeof entry.lastSeen === "string"
            ? Date.parse(entry.lastSeen)
            : Number.NaN;
        if (!Number.isFinite(lastSeen)) continue;
        models.set(entry.id, lastSeen);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger.debug("[models] failed to read discovered model registry", {
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  prune(models);
  cache = models;
  cachePath = filePath;
  return models;
}

function persist(models: Map<string, number>): void {
  const filePath = getDiscoveredModelsPath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload: PersistedDiscoveredModels = {
      version: 1,
      models: [...models.entries()].map(([id, lastSeen]) => ({
        id,
        lastSeen: new Date(lastSeen).toISOString(),
      })),
    };
    const temporaryPath = `${filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    logger.warn("[models] failed to persist discovered model registry", {
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Remember a model id that Qwen accepted for a completion. Safe to call for
 * every request: ids are de-duplicated and the file is rewritten at most once
 * per hour unless a new id is discovered.
 */
export function recordDiscoveredModel(modelId: string): void {
  if (typeof modelId !== "string") return;
  const id = modelId.trim();
  if (!MODEL_ID_PATTERN.test(id)) return;

  const models = load();
  const now = Date.now();
  const previous = models.get(id);
  models.set(id, now);

  if (previous === undefined) {
    prune(models);
    logger.debug("[models] discovered a new upstream model", { model: id });
    persist(models);
    return;
  }
  if (now - previous >= REFRESH_PERSIST_INTERVAL_MS) {
    persist(models);
  }
}

/** Discovered model ids, newest first. */
export function listDiscoveredModels(): string[] {
  const models = load();
  prune(models);
  return [...models.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([id]) => id);
}

/** Test-only reset. Optionally removes the persisted registry file. */
export function resetDiscoveredModelsForTests(removeFile = false): void {
  cache = null;
  cachePath = null;
  if (!removeFile) return;
  try {
    fs.unlinkSync(getDiscoveredModelsPath());
  } catch {
    // Nothing to remove.
  }
}
