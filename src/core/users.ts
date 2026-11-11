/**
 * Multi-user API keys backed by SQLite.
 *
 * Plaintext keys are never stored: only a SHA-256 digest and a short display
 * prefix. Generated keys use 192 bits of randomness, so SHA-256 is sufficient
 * (no slow password hash on every request).
 */

import crypto from "node:crypto";
import { getDatabase } from "./database.ts";
import { config } from "./config.ts";
import { publishRedisEvent } from "./redis-store.ts";

export type UserRole = "admin" | "user";

export interface UserRecord {
  id: string;
  label: string;
  api_key_hash: string;
  api_key_prefix: string;
  role: UserRole;
  rate_limit_rpm: number;
  max_concurrency: number;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export interface PublicUser {
  id: string;
  label: string;
  role: UserRole;
  prefix: string;
  rate_limit_rpm: number;
  max_concurrency: number;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export interface UserIdentity {
  id: string;
  label: string;
  role: UserRole;
  rateLimitRpm: number;
  maxConcurrency: number;
  legacy: boolean;
}

export interface CreatedUser {
  user: PublicUser;
  apiKey: string;
}

export interface CreateUserOptions {
  role?: UserRole;
  rpm?: number;
  concurrency?: number;
}

const KEY_PREFIX = "sk-qpx-";

/** True for keys minted by this proxy (used to reject stale/rotated keys). */
export function looksLikeProxyApiKey(value: string): boolean {
  return value.startsWith(KEY_PREFIX);
}

export function generateApiKey(): string {
  return `${KEY_PREFIX}${crypto.randomBytes(24).toString("base64url")}`;
}

export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

export function displayPrefix(key: string): string {
  return key.slice(0, 12);
}

function toPublicUser(row: UserRecord): PublicUser {
  return {
    id: row.id,
    label: row.label,
    role: row.role,
    prefix: row.api_key_prefix,
    rate_limit_rpm: row.rate_limit_rpm,
    max_concurrency: row.max_concurrency,
    created_at: row.created_at,
    updated_at: row.updated_at,
    revoked_at: row.revoked_at,
  };
}

function publishUserRow(id: string): void {
  if (!id) return;
  try {
    const row = getDatabase().prepare("SELECT * FROM users WHERE id = ?").get(id);
    if (row) publishRedisEvent("user", "upsert", id, row);
  } catch {
    // Sharing is best-effort; local SQLite remains authoritative.
  }
}

function validateLimit(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Math.trunc(value);
}

const seededSpecs = new Set<string>();

/**
 * Seed users from USER_API_KEYS:
 *   key:label[:rpm[:concurrency]],...
 * Existing keys/labels are left untouched, so a restart never rotates a key.
 * The optional arguments exist for tests; production calls it with no args.
 */
export function seedEnvUsers(
  raw = config.users.apiKeys,
  defaults: { rpm: number; concurrency: number } = {
    rpm: config.users.defaultRpm,
    concurrency: config.users.defaultConcurrency,
  },
): void {
  const spec = raw.trim();
  if (!spec) return;
  const specKey = `${spec}\u0000${defaults.rpm}\u0000${defaults.concurrency}`;
  if (seededSpecs.has(specKey)) return;

  const db = getDatabase();
  const insert = db.prepare(`
    INSERT INTO users (id, label, api_key_hash, api_key_prefix, role, rate_limit_rpm, max_concurrency)
    VALUES (?, ?, ?, ?, 'user', ?, ?)
  `);
  const exists = db.prepare(
    "SELECT id FROM users WHERE api_key_hash = ? OR lower(label) = lower(?)",
  );

  for (const entry of spec.split(",")) {
    const parts = entry.trim().split(":");
    if (parts.length < 2) continue;
    const key = parts[0].trim();
    const label = parts[1].trim();
    if (!key || !label) continue;
    const rpm = parts[2]
      ? Math.max(0, parseInt(parts[2], 10) || 0)
      : defaults.rpm;
    const concurrency = parts[3]
      ? Math.max(0, parseInt(parts[3], 10) || 0)
      : defaults.concurrency;
    const hash = hashApiKey(key);
    if (exists.get(hash, label)) continue;
    const id = crypto.randomUUID();
    insert.run(id, label, hash, displayPrefix(key), rpm, concurrency);
    publishUserRow(id);
  }

  seededSpecs.add(specKey);
}

export function listUsers(): PublicUser[] {
  seedEnvUsers();
  const rows = getDatabase()
    .prepare("SELECT * FROM users ORDER BY created_at ASC")
    .all() as UserRecord[];
  return rows.map(toPublicUser);
}

export function getUserById(id: string): PublicUser | undefined {
  seedEnvUsers();
  const row = getDatabase()
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(id) as UserRecord | undefined;
  return row ? toPublicUser(row) : undefined;
}

export function getUserByLabel(label: string): PublicUser | undefined {
  seedEnvUsers();
  const row = getDatabase()
    .prepare("SELECT * FROM users WHERE lower(label) = lower(?)")
    .get(label.trim()) as UserRecord | undefined;
  return row ? toPublicUser(row) : undefined;
}

/**
 * Internal credential digest used to revalidate sessions after a key rotation.
 * Never include this value in admin API responses.
 */
export function getUserApiKeyHash(id: string): string | null {
  seedEnvUsers();
  const row = getDatabase()
    .prepare("SELECT api_key_hash FROM users WHERE id = ?")
    .get(id) as { api_key_hash: string } | undefined;
  return row?.api_key_hash ?? null;
}

/**
 * Look up a key including revoked rows. Callers need the distinction to reject
 * a revoked key instead of falling back to loopback local-admin trust.
 */
export function findUserByKeyIncludingRevoked(
  key: string,
): UserRecord | null {
  seedEnvUsers();
  const hash = hashApiKey(key);
  const row = getDatabase()
    .prepare("SELECT * FROM users WHERE api_key_hash = ?")
    .get(hash) as UserRecord | undefined;
  return row ?? null;
}

export function findUserByKey(key: string): UserRecord | null {
  const row = findUserByKeyIncludingRevoked(key);
  if (!row || row.revoked_at) return null;
  return row;
}

export function createUser(
  label: string,
  options: CreateUserOptions = {},
): CreatedUser {
  const trimmed = label.trim();
  if (!trimmed) throw new Error("label is required");
  const role: UserRole = options.role === "admin" ? "admin" : "user";
  const rpm = validateLimit("rpm", options.rpm ?? config.users.defaultRpm);
  const concurrency = validateLimit(
    "concurrency",
    options.concurrency ?? config.users.defaultConcurrency,
  );
  const apiKey = generateApiKey();
  const db = getDatabase();
  const existing = db
    .prepare("SELECT id FROM users WHERE lower(label) = lower(?)")
    .get(trimmed);
  if (existing) throw new Error(`User label already exists: ${trimmed}`);

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO users (id, label, api_key_hash, api_key_prefix, role, rate_limit_rpm, max_concurrency)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    trimmed,
    hashApiKey(apiKey),
    displayPrefix(apiKey),
    role,
    rpm,
    concurrency,
  );
  publishUserRow(id);
  const user = getUserById(id);
  if (!user) throw new Error("Failed to read created user");
  return { user, apiKey };
}

export function updateUserLimits(
  id: string,
  rpm: number,
  concurrency: number,
): PublicUser {
  const nextRpm = validateLimit("rpm", rpm);
  const nextConcurrency = validateLimit("concurrency", concurrency);
  const db = getDatabase();
  const result = db
    .prepare(
      "UPDATE users SET rate_limit_rpm = ?, max_concurrency = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .run(nextRpm, nextConcurrency, id);
  if (result.changes === 0) throw new Error(`Unknown user: ${id}`);
  publishUserRow(id);
  const user = getUserById(id);
  if (!user) throw new Error(`Unknown user: ${id}`);
  return user;
}

export function rotateUserKey(id: string): CreatedUser {
  const apiKey = generateApiKey();
  const db = getDatabase();
  const result = db
    .prepare(
      "UPDATE users SET api_key_hash = ?, api_key_prefix = ?, revoked_at = NULL, updated_at = datetime('now') WHERE id = ?",
    )
    .run(hashApiKey(apiKey), displayPrefix(apiKey), id);
  if (result.changes === 0) throw new Error(`Unknown user: ${id}`);
  publishUserRow(id);
  const user = getUserById(id);
  if (!user) throw new Error(`Unknown user: ${id}`);
  return { user, apiKey };
}

export function revokeUser(id: string): boolean {
  const result = getDatabase()
    .prepare(
      "UPDATE users SET revoked_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND revoked_at IS NULL",
    )
    .run(id);
  if (result.changes > 0) publishUserRow(id);
  return result.changes > 0;
}

export function hasConfiguredUsers(): boolean {
  seedEnvUsers();
  const row = getDatabase()
    .prepare("SELECT COUNT(*) AS c FROM users WHERE revoked_at IS NULL")
    .get() as { c: number };
  return row.c > 0;
}
