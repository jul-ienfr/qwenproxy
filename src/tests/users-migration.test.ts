import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { runMigrations } from "../core/database.ts";

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

interface LegacyUserRow {
  id: string;
  email: string;
  api_key: string;
  rate_limit_rpm: number;
  max_concurrency: number;
}

function createLegacyUsersTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      api_key TEXT UNIQUE NOT NULL,
      rate_limit_rpm INTEGER NOT NULL DEFAULT 0,
      max_concurrency INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function insertLegacyUser(db: Database.Database, row: LegacyUserRow): void {
  db.prepare(
    `INSERT INTO users (id, email, api_key, rate_limit_rpm, max_concurrency)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.email,
    row.api_key,
    row.rate_limit_rpm,
    row.max_concurrency,
  );
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );
}

test("legacy plaintext users migrate into the hashed schema", () => {
  const db = new Database(":memory:");
  try {
    createLegacyUsersTable(db);
    insertLegacyUser(db, {
      id: "user-1",
      email: "omni",
      api_key: "sk-legacy-omni",
      rate_limit_rpm: 120,
      max_concurrency: 8,
    });
    insertLegacyUser(db, {
      id: "userTwo",
      email: "userTwo",
      api_key: "sk-user-b",
      rate_limit_rpm: 0,
      max_concurrency: 0,
    });

    runMigrations(db);

    const rows = db
      .prepare("SELECT * FROM users ORDER BY label")
      .all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);

    const omni = rows.find((row) => row.label === "omni");
    assert.ok(omni, "migrated row keeps the legacy email as label");
    assert.equal(omni.id, "user-1");
    assert.equal(omni.api_key_hash, sha256("sk-legacy-omni"));
    assert.equal(omni.api_key_prefix, "sk-legacy-om");
    assert.equal(omni.role, "user");
    assert.equal(omni.rate_limit_rpm, 120);
    assert.equal(omni.max_concurrency, 8);
    assert.equal(omni.revoked_at, null);

    // The migrated key remains valid: lookup by digest returns the row.
    const byHash = db
      .prepare("SELECT label FROM users WHERE api_key_hash = ?")
      .get(sha256("sk-user-b"));
    assert.deepEqual(byHash, { label: "userTwo" });

    // Plaintext keys are gone from the active table.
    assert.ok(
      rows.every((row) => !Object.values(row).includes("sk-legacy-omni")),
    );

    // The original table is preserved for audit under a versioned name.
    assert.ok(tableExists(db, "users_legacy_v1_migrated"));
    const preserved = db
      .prepare("SELECT * FROM users_legacy_v1_migrated ORDER BY email")
      .all() as Array<Record<string, unknown>>;
    assert.equal(preserved.length, 2);
    assert.equal(preserved[0].api_key, "sk-legacy-omni");
  } finally {
    db.close();
  }
});

test("rerunning migrations after a legacy migration is idempotent", () => {
  const db = new Database(":memory:");
  try {
    createLegacyUsersTable(db);
    insertLegacyUser(db, {
      id: "user-1",
      email: "omni",
      api_key: "sk-legacy-omni",
      rate_limit_rpm: 120,
      max_concurrency: 8,
    });

    runMigrations(db);
    runMigrations(db);

    const count = db
      .prepare("SELECT COUNT(*) AS count FROM users")
      .get() as { count: number };
    assert.equal(count.count, 1);

    assert.ok(tableExists(db, "users_legacy_v1_migrated"));
    const preserved = db
      .prepare("SELECT COUNT(*) AS count FROM users_legacy_v1_migrated")
      .get() as { count: number };
    assert.equal(preserved.count, 1);
  } finally {
    db.close();
  }
});

test("migration resumes when the legacy table was already renamed", () => {
  const db = new Database(":memory:");
  try {
    // Simulate a run that renamed users -> users_legacy_v1 and crashed before
    // copying rows: the hashed schema exists but is still empty.
    createLegacyUsersTable(db);
    insertLegacyUser(db, {
      id: "user-1",
      email: "omni",
      api_key: "sk-legacy-omni",
      rate_limit_rpm: 120,
      max_concurrency: 8,
    });
    db.exec(`ALTER TABLE users RENAME TO users_legacy_v1`);
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL UNIQUE,
        api_key_hash TEXT NOT NULL UNIQUE,
        api_key_prefix TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        rate_limit_rpm INTEGER NOT NULL DEFAULT 0,
        max_concurrency INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        revoked_at TEXT
      );
    `);

    runMigrations(db);

    const row = db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get("user-1") as Record<string, unknown> | undefined;
    assert.ok(row);
    assert.equal(row.api_key_hash, sha256("sk-legacy-omni"));
    assert.ok(tableExists(db, "users_legacy_v1_migrated"));

    // A second run must not copy the row again.
    runMigrations(db);
    const count = db
      .prepare("SELECT COUNT(*) AS count FROM users")
      .get() as { count: number };
    assert.equal(count.count, 1);
  } finally {
    db.close();
  }
});
