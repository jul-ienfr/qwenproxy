import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  deleteAuthSession,
  getDatabase,
  getValidAuthSession,
  migrateAuthSessionSecrets,
  saveAuthSession,
} from "../core/database.ts";
import { isEncrypted } from "../core/crypto-utils.ts";
import { getDbDir } from "../core/paths.ts";

const ACCOUNT = "test-enc-account-1";
const CLEARTEXT_ACCOUNT = "test-enc-account-2";

interface RawSessionRow {
  cookie: string | null;
  bx_ua: string | null;
  bx_umidtoken: string | null;
  refresh_token: string | null;
}

function rawRow(accountId: string): RawSessionRow | undefined {
  return getDatabase()
    .prepare(
      "SELECT cookie, bx_ua, bx_umidtoken, refresh_token FROM qwen_auth_sessions WHERE account_id = ?",
    )
    .get(accountId) as RawSessionRow | undefined;
}

test("auth session: cookie, bx tokens and refresh token are encrypted at rest", () => {
  deleteAuthSession(ACCOUNT);
  try {
    saveAuthSession(ACCOUNT, {
      cookie: "cookie-plain-value",
      userAgent: "UA/1.0",
      bxV: "2.5.0",
      bxUa: "bxua-plain",
      bxUmidtoken: "bxumid-plain",
      refreshToken: "refresh-plain",
      capturedAt: Date.now(),
    });

    const row = rawRow(ACCOUNT);
    assert.ok(row, "expected a stored row");
    assert.notEqual(row.cookie, "cookie-plain-value");
    assert.notEqual(row.bx_ua, "bxua-plain");
    assert.notEqual(row.bx_umidtoken, "bxumid-plain");
    assert.notEqual(row.refresh_token, "refresh-plain");
    assert.equal(isEncrypted(row.cookie ?? ""), true);
    assert.equal(isEncrypted(row.bx_ua ?? ""), true);
    assert.equal(isEncrypted(row.bx_umidtoken ?? ""), true);
    assert.equal(isEncrypted(row.refresh_token ?? ""), true);

    const session = getValidAuthSession(ACCOUNT);
    assert.ok(session, "round-trip must succeed");
    assert.equal(session.cookie, "cookie-plain-value");
    assert.equal(session.bxUa, "bxua-plain");
    assert.equal(session.bxUmidtoken, "bxumid-plain");
    assert.equal(session.refreshToken, "refresh-plain");
  } finally {
    deleteAuthSession(ACCOUNT);
  }
});

test("auth session: a legacy cleartext row is migrated and stays readable", () => {
  deleteAuthSession(CLEARTEXT_ACCOUNT);
  try {
    getDatabase()
      .prepare(
        `INSERT INTO qwen_auth_sessions (
           account_id, cookie, user_agent, bx_v, bx_ua, bx_umidtoken,
           refresh_token, captured_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        CLEARTEXT_ACCOUNT,
        "legacy-cookie",
        "UA/1.0",
        "2.5.0",
        "legacy-bxua",
        "legacy-bxumid",
        "legacy-refresh",
        Date.now(),
      );

    const before = rawRow(CLEARTEXT_ACCOUNT);
    assert.equal(before?.cookie, "legacy-cookie");

    const migrated = migrateAuthSessionSecrets();
    assert.ok(migrated >= 1, "the cleartext row must be migrated");

    const after = rawRow(CLEARTEXT_ACCOUNT);
    assert.equal(isEncrypted(after?.cookie ?? ""), true);
    assert.equal(isEncrypted(after?.bx_umidtoken ?? ""), true);
    assert.equal(isEncrypted(after?.refresh_token ?? ""), true);

    const session = getValidAuthSession(CLEARTEXT_ACCOUNT);
    assert.ok(session, "migrated session must still read back");
    assert.equal(session.cookie, "legacy-cookie");
    assert.equal(session.refreshToken, "legacy-refresh");

    migrateAuthSessionSecrets();
    const afterSecondRun = rawRow(CLEARTEXT_ACCOUNT);
    assert.equal(
      afterSecondRun?.cookie,
      after?.cookie,
      "migration must be idempotent",
    );
  } finally {
    deleteAuthSession(CLEARTEXT_ACCOUNT);
  }
});

test("auth session: the data directory is owner-only on POSIX", () => {
  if (process.platform === "win32") return;
  const mode = fs.statSync(getDbDir()).mode & 0o777;
  assert.equal(mode, 0o700);
});
