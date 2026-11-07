import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getDatabase } from "../core/database.ts";
import {
  createUser,
  displayPrefix,
  findUserByKey,
  generateApiKey,
  getUserByLabel,
  getUserById,
  hashApiKey,
  listUsers,
  revokeUser,
  rotateUserKey,
  seedEnvUsers,
  updateUserLimits,
} from "../core/users.ts";

const db = getDatabase();

let snapshot: Array<Record<string, unknown>> = [];

beforeEach(() => {
  snapshot = db.prepare("SELECT * FROM users").all() as Array<
    Record<string, unknown>
  >;
  db.prepare("DELETE FROM users").run();
});

afterEach(() => {
  db.prepare("DELETE FROM users").run();
  const insert = db.prepare(`
    INSERT INTO users (
      id, label, api_key_hash, api_key_prefix, role,
      rate_limit_rpm, max_concurrency, created_at, updated_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of snapshot) {
    insert.run(
      row.id,
      row.label,
      row.api_key_hash,
      row.api_key_prefix,
      row.role,
      row.rate_limit_rpm,
      row.max_concurrency,
      row.created_at,
      row.updated_at,
      row.revoked_at,
    );
  }
});

test("users: generated keys are high-entropy and hash to a stable digest", () => {
  const key = generateApiKey();
  assert.match(key, /^sk-qpx-[A-Za-z0-9_-]{32}$/);
  assert.equal(displayPrefix(key), key.slice(0, 12));
  assert.match(hashApiKey(key), /^[a-f0-9]{64}$/);
  assert.equal(hashApiKey(key), hashApiKey(key));
  assert.notEqual(generateApiKey(), generateApiKey());
});

test("users: create stores only the hash and resolves the plaintext key", () => {
  const created = createUser("alice", { rpm: 10, concurrency: 2 });
  assert.equal(created.user.label, "alice");
  assert.equal(created.user.role, "user");
  assert.equal(created.user.rate_limit_rpm, 10);
  assert.equal(created.user.max_concurrency, 2);
  assert.equal(created.user.prefix, displayPrefix(created.apiKey));

  const stored = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(created.user.id) as Record<string, unknown>;
  assert.equal(stored.api_key_hash, hashApiKey(created.apiKey));
  assert.notEqual(stored.api_key_hash, created.apiKey);
  assert.equal(stored.api_key_prefix, displayPrefix(created.apiKey));

  const found = findUserByKey(created.apiKey);
  assert.equal(found?.id, created.user.id);
  assert.equal(found?.rate_limit_rpm, 10);
  assert.equal(findUserByKey("sk-qpx-wrong"), null);
});

test("users: labels are unique and lookups are case-insensitive", () => {
  const created = createUser("Team-A", { rpm: 0, concurrency: 0 });
  assert.equal(getUserByLabel("team-a")?.id, created.user.id);
  assert.equal(getUserById(created.user.id)?.label, "Team-A");
  assert.throws(() => createUser("team-a"), /already exists/);
  assert.throws(() => createUser("   "), /label is required/);
  assert.throws(
    () => createUser("negative", { rpm: -1 }),
    /non-negative integer/,
  );
});

test("users: rotate invalidates the old key and revoke fails closed", () => {
  const created = createUser("bob", { rpm: 5, concurrency: 1 });
  const oldKey = created.apiKey;

  const rotated = rotateUserKey(created.user.id);
  assert.notEqual(rotated.apiKey, oldKey);
  assert.equal(findUserByKey(oldKey), null);
  assert.equal(findUserByKey(rotated.apiKey)?.id, created.user.id);

  assert.equal(revokeUser(created.user.id), true);
  assert.equal(findUserByKey(rotated.apiKey), null);
  assert.equal(revokeUser(created.user.id), false);

  const listed = listUsers().find((user) => user.id === created.user.id);
  assert.ok(listed?.revoked_at);

  const restored = rotateUserKey(created.user.id);
  assert.equal(findUserByKey(restored.apiKey)?.revoked_at, null);
});

test("users: limits update validates and persists", () => {
  const created = createUser("carol", { rpm: 5, concurrency: 1 });
  const updated = updateUserLimits(created.user.id, 60, 4);
  assert.equal(updated.rate_limit_rpm, 60);
  assert.equal(updated.max_concurrency, 4);
  assert.throws(
    () => updateUserLimits(created.user.id, -1, 0),
    /non-negative integer/,
  );
  assert.throws(
    () => updateUserLimits("missing", 0, 0),
    /Unknown user/,
  );
});

test("users: USER_API_KEYS seeding is idempotent and applies limits", () => {
  seedEnvUsers("sk-env-seed-1:env-one:7:3,sk-env-seed-2:env-two", {
    rpm: 9,
    concurrency: 4,
  });

  const first = findUserByKey("sk-env-seed-1");
  assert.equal(first?.label, "env-one");
  assert.equal(first?.rate_limit_rpm, 7);
  assert.equal(first?.max_concurrency, 3);

  const second = findUserByKey("sk-env-seed-2");
  assert.equal(second?.label, "env-two");
  assert.equal(second?.rate_limit_rpm, 9);
  assert.equal(second?.max_concurrency, 4);

  seedEnvUsers("sk-env-seed-1:env-one:7:3,sk-env-seed-2:env-two", {
    rpm: 9,
    concurrency: 4,
  });
  assert.equal(
    listUsers().filter((user) => user.label.startsWith("env-")).length,
    2,
  );
});
