/**
 * Runtime model mapping (alias -> Qwen model id).
 *
 * Operators can keep hardcoded client model names working when Qwen rotates
 * its catalog:
 *
 *   MODEL_MAP="gpt-4o=qwen3.8-max,claude-sonnet=qwen3.8-max,*=qwen3.7-plus"
 *
 * The same mapping can be edited from the admin API/dashboard without a
 * restart. Persistence lives in `data/model-mappings.json`; the environment
 * variable is only a seed used while that file does not exist.
 *
 * Resolution precedence is implemented by the callers in `model-alias.ts`:
 * exact runtime alias -> built-in family alias -> wildcard fallback ->
 * passthrough. Qwen-native ids are never rewritten by the wildcard.
 */

import fs from "node:fs";
import path from "node:path";
import { getModelMappingsPath } from "./paths.ts";

export type ModelMappingSource = "file" | "env" | "default";

export interface ModelMappingEntry {
  alias: string;
  target: string;
  updatedAt: string;
}

export interface ModelMappingState {
  mappings: ModelMappingEntry[];
  fallback: string | null;
  source: ModelMappingSource;
  updatedAt: string | null;
  filePath: string;
}

export interface ModelMappingValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ModelMappingInput {
  mappings: Array<{ alias: string; target: string; updatedAt?: string }>;
  fallback: string | null;
}

interface PersistedModelMappings {
  version: 1;
  mappings: ModelMappingEntry[];
  fallback: string | null;
  updatedAt: string;
}

interface MappingCache {
  filePath: string;
  mtimeMs: number | null;
  state: ModelMappingState;
}

/**
 * Aliases ending with a public reasoning/search suffix can never match: the
 * request pipeline strips those suffixes before model resolution.
 */
const RESERVED_ALIAS_SUFFIX =
  /-(?:search|low|medium|high|fast|no-thinking|thinking)$/i;

/**
 * Upstream-native ids that must pass through untouched even when a wildcard
 * fallback is configured. Keep in sync with Qwen's first-party model families
 * (chat, image and video generation).
 */
const UPSTREAM_NATIVE_PATTERN = /^(?:qwen|wan\d|z-image)/i;

let cache: MappingCache | null = null;

export function resetModelMappingCacheForTests(): void {
  cache = null;
}

export function isUpstreamNativeModel(model: string): boolean {
  return UPSTREAM_NATIVE_PATTERN.test(model.trim());
}

function fileMtime(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function emptyState(
  filePath: string,
  source: ModelMappingSource = "default",
  updatedAt: string | null = null,
): ModelMappingState {
  return {
    mappings: [],
    fallback: null,
    source,
    updatedAt,
    filePath,
  };
}

function cloneState(state: ModelMappingState): ModelMappingState {
  return {
    mappings: state.mappings.map((entry) => ({ ...entry })),
    fallback: state.fallback,
    source: state.source,
    updatedAt: state.updatedAt,
    filePath: state.filePath,
  };
}

/**
 * Parse the compact `alias=qwen-id,...,*=fallback` syntax used by `MODEL_MAP`.
 * Invalid items are reported as errors instead of being silently dropped so
 * an operator sees typos immediately.
 */
export function parseModelMap(input: string): {
  mappings: ModelMappingEntry[];
  fallback: string | null;
  errors: string[];
} {
  const now = new Date().toISOString();
  const mappings: ModelMappingEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  let fallback: string | null = null;
  let fallbackSeen = false;

  for (const rawPart of String(input ?? "").split(/[,\n;]+/)) {
    const part = rawPart.trim();
    if (!part || part.startsWith("#")) continue;

    const separator = part.indexOf("=");
    if (separator <= 0) {
      errors.push(`Invalid mapping '${part}': expected alias=target`);
      continue;
    }

    const alias = part.slice(0, separator).trim();
    const target = part.slice(separator + 1).trim();
    if (!alias || !target) {
      errors.push(`Invalid mapping '${part}': alias and target must not be empty`);
      continue;
    }

    if (alias === "*") {
      if (fallbackSeen) {
        errors.push("Invalid mapping: wildcard fallback '*' is defined more than once");
        continue;
      }
      fallbackSeen = true;
      fallback = target;
      continue;
    }

    const key = alias.toLowerCase();
    if (seen.has(key)) {
      errors.push(`Invalid mapping '${alias}': duplicate alias`);
      continue;
    }
    seen.add(key);
    mappings.push({ alias, target, updatedAt: now });
  }

  return { mappings, fallback, errors };
}

function validateEntry(aliasInput: string, targetInput: string): string[] {
  const errors: string[] = [];
  const alias = String(aliasInput ?? "").trim();
  const target = String(targetInput ?? "").trim();

  if (!alias) {
    errors.push("Mapping alias must not be empty");
    return errors;
  }
  if (alias === "*") {
    errors.push("Wildcard '*' is only allowed as a standalone fallback");
  }
  if (/\s/.test(alias)) {
    errors.push(`Alias '${alias}' must not contain whitespace`);
  }
  if (alias.toLowerCase().startsWith("qwen")) {
    errors.push(
      `Alias '${alias}' must not start with 'qwen' (upstream-native ids are never rewritten)`,
    );
  } else if (isUpstreamNativeModel(alias)) {
    errors.push(
      `Alias '${alias}' is an upstream-native media model id and cannot be remapped`,
    );
  }
  if (RESERVED_ALIAS_SUFFIX.test(alias)) {
    errors.push(
      `Alias '${alias}' ends with a reserved reasoning/search suffix`,
    );
  }
  if (!target) {
    errors.push(`Alias '${alias}' must have a non-empty target`);
  } else if (/\s/.test(target)) {
    errors.push(`Alias '${alias}' target must not contain whitespace`);
  } else if (RESERVED_ALIAS_SUFFIX.test(target)) {
    errors.push(
      `Alias '${alias}' target '${target}' must be a base model id (reasoning/search suffixes are configured per request)`,
    );
  }

  return errors;
}

/**
 * Validate a complete mapping set. Alias chains are rejected instead of
 * resolved so a cycle can never introduce an infinite lookup at request time.
 */
export function validateModelMappings(
  mappings: Array<{ alias: string; target: string }>,
  fallback: string | null,
): ModelMappingValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const keys = new Set<string>();

  for (const mapping of mappings) {
    const alias = String(mapping.alias ?? "").trim();
    const target = String(mapping.target ?? "").trim();
    errors.push(...validateEntry(alias, target));

    const key = alias.toLowerCase();
    if (key && seen.has(key)) {
      errors.push(`Duplicate alias '${alias}' (aliases are case-insensitive)`);
    }
    if (key) {
      seen.add(key);
      keys.add(key);
    }
  }

  for (const mapping of mappings) {
    const target = String(mapping.target ?? "").trim().toLowerCase();
    if (target && keys.has(target)) {
      errors.push(
        `Alias chain not supported: '${mapping.alias}' targets alias '${mapping.target}'`,
      );
    }
  }

  if (fallback !== null && fallback !== undefined) {
    const value = String(fallback).trim();
    if (!value) {
      errors.push("Wildcard fallback target must not be empty");
    } else if (/\s/.test(value)) {
      errors.push("Wildcard fallback target must not contain whitespace");
    } else if (keys.has(value.toLowerCase())) {
      errors.push("Wildcard fallback target must not be an alias");
    } else {
      warnings.push(
        "Wildcard fallback is configured; unknown non-Qwen model names will be rewritten.",
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function normalizeRawMappings(
  raw: unknown,
): Array<{ alias: string; target: string; updatedAt?: string }> {
  if (Array.isArray(raw)) {
    return raw
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => {
        const record = entry as Record<string, unknown>;
        return {
          alias: String(record.alias ?? ""),
          target: String(record.target ?? ""),
          updatedAt:
            typeof record.updatedAt === "string" ? record.updatedAt : undefined,
        };
      });
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(
      ([alias, target]) => ({
        alias,
        target: String(target ?? ""),
      }),
    );
  }
  return [];
}

/**
 * Drop invalid entries from hand-edited/env data instead of disabling every
 * mapping. Admin writes go through `saveModelMappings`, which rejects the
 * whole payload when validation fails.
 */
function sanitizeMappings(
  mappings: Array<{ alias: string; target: string; updatedAt?: string }>,
  fallback: string | null,
): {
  mappings: ModelMappingEntry[];
  fallback: string | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  const entries: ModelMappingEntry[] = [];
  const seen = new Set<string>();
  const now = new Date().toISOString();

  for (const mapping of mappings) {
    const alias = String(mapping.alias ?? "").trim();
    const target = String(mapping.target ?? "").trim();
    const errors = validateEntry(alias, target);
    if (errors.length > 0) {
      warnings.push(...errors);
      continue;
    }
    const key = alias.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`Duplicate alias '${alias}' ignored`);
      continue;
    }
    seen.add(key);
    entries.push({
      alias,
      target,
      updatedAt: mapping.updatedAt || now,
    });
  }

  let normalizedFallback: string | null = null;
  const keys = new Set(entries.map((entry) => entry.alias.toLowerCase()));
  const withoutChains = entries.filter((entry) => {
    if (keys.has(entry.target.toLowerCase())) {
      warnings.push(
        `Alias chain '${entry.alias}' -> '${entry.target}' ignored`,
      );
      return false;
    }
    return true;
  });
  const finalKeys = new Set(
    withoutChains.map((entry) => entry.alias.toLowerCase()),
  );

  if (fallback !== null && fallback !== undefined) {
    const value = String(fallback).trim();
    if (!value) {
      warnings.push("Empty wildcard fallback ignored");
    } else if (/\s/.test(value)) {
      warnings.push("Wildcard fallback with whitespace ignored");
    } else if (finalKeys.has(value.toLowerCase())) {
      warnings.push("Wildcard fallback targeting an alias ignored");
    } else {
      normalizedFallback = value;
    }
  }

  return {
    mappings: withoutChains,
    fallback: normalizedFallback,
    warnings,
  };
}

function readEnvState(filePath: string): ModelMappingState {
  const raw = String(process.env.MODEL_MAP ?? "").trim();
  if (!raw) return emptyState(filePath);

  const parsed = parseModelMap(raw);
  const { mappings, fallback, warnings } = sanitizeMappings(
    parsed.mappings,
    parsed.fallback,
  );
  for (const warning of [...parsed.errors, ...warnings]) {
    console.warn(`[model-mapping] ${warning}`);
  }
  return {
    mappings,
    fallback,
    source: "env",
    updatedAt: null,
    filePath,
  };
}

function readFileState(filePath: string): ModelMappingState {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<
      string,
      unknown
    >;
    const mappings = normalizeRawMappings(raw?.mappings);
    const fallback =
      typeof raw?.fallback === "string"
        ? raw.fallback
        : typeof raw?.wildcard === "string"
          ? raw.wildcard
          : null;
    const { mappings: sanitized, fallback: sanitizedFallback, warnings } =
      sanitizeMappings(mappings, fallback);
    for (const warning of warnings) {
      console.warn(`[model-mapping] ${warning}`);
    }
    const updatedAt =
      typeof raw?.updatedAt === "string" ? raw.updatedAt : null;
    return {
      mappings: sanitized,
      fallback: sanitizedFallback,
      source: "file",
      updatedAt,
      filePath,
    };
  } catch (error) {
    console.warn(
      `[model-mapping] Ignoring unreadable mapping file ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return emptyState(filePath, "file");
  }
}

function loadState(): ModelMappingState {
  const filePath = getModelMappingsPath();
  const mtimeMs = fileMtime(filePath);

  if (
    cache &&
    cache.filePath === filePath &&
    cache.mtimeMs === mtimeMs
  ) {
    return cloneState(cache.state);
  }

  const state =
    mtimeMs === null ? readEnvState(filePath) : readFileState(filePath);
  cache = { filePath, mtimeMs, state };
  return cloneState(state);
}

export function getModelMappingState(): ModelMappingState {
  return loadState();
}

/** Exact, case-insensitive alias lookup. */
export function findExactModelMapping(
  model: string,
): ModelMappingEntry | undefined {
  const needle = String(model ?? "").trim().toLowerCase();
  if (!needle) return undefined;
  return loadState().mappings.find(
    (entry) => entry.alias.toLowerCase() === needle,
  );
}

/**
 * Wildcard fallback for an unknown model, or `undefined` when it is disabled
 * or the requested id is upstream-native.
 */
export function getModelMappingFallback(model: string): string | undefined {
  const state = loadState();
  if (!state.fallback) return undefined;
  if (isUpstreamNativeModel(model)) return undefined;
  return state.fallback;
}

/**
 * Persist a complete mapping set. Throws with an actionable message when the
 * payload is invalid so the admin API can return HTTP 400.
 */
export function saveModelMappings(input: ModelMappingInput): ModelMappingState {
  const normalized = normalizeRawMappings(input.mappings);
  const fallback =
    input.fallback === null || input.fallback === undefined
      ? null
      : String(input.fallback).trim();

  const validation = validateModelMappings(normalized, fallback);
  if (!validation.valid) {
    throw new Error(
      `Invalid model mapping: ${validation.errors.join("; ")}`,
    );
  }

  const filePath = getModelMappingsPath();
  const previous = new Map(
    loadState().mappings.map((entry) => [entry.alias.toLowerCase(), entry]),
  );
  const now = new Date().toISOString();
  const mappings: ModelMappingEntry[] = normalized.map((entry) => {
    const alias = String(entry.alias).trim();
    const target = String(entry.target).trim();
    const prior = previous.get(alias.toLowerCase());
    return {
      alias,
      target,
      updatedAt:
        prior && prior.target === target ? prior.updatedAt : now,
    };
  });

  const persisted: PersistedModelMappings = {
    version: 1,
    mappings,
    fallback: fallback || null,
    updatedAt: now,
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(
    tempPath,
    `${JSON.stringify(persisted, null, 2)}\n`,
    { encoding: "utf-8", mode: 0o600 },
  );
  try {
    fs.renameSync(tempPath, filePath);
  } catch {
    // Some Windows filesystems refuse replacing an existing file with
    // rename; fall back to a direct write rather than failing the save.
    fs.writeFileSync(filePath, `${JSON.stringify(persisted, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    try {
      fs.unlinkSync(tempPath);
    } catch {}
  }

  cache = null;
  return getModelMappingState();
}

/** Remove the persisted file and fall back to the `MODEL_MAP` seed. */
export function resetModelMappings(): ModelMappingState {
  const filePath = getModelMappingsPath();
  try {
    fs.unlinkSync(filePath);
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  cache = null;
  return getModelMappingState();
}
