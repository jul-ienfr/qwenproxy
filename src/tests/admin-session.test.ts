import test from "node:test";
import assert from "node:assert/strict";

import {
  ADMIN_SESSION_COOKIE,
  buildClearedSessionCookie,
  buildSessionCookie,
  createAdminSession,
  identityFromSession,
  readSessionCookie,
  validateCsrf,
  verifyAdminSession,
} from "../core/admin-session.ts";
import type { UserIdentity } from "../core/users.ts";

const adminIdentity: UserIdentity = {
  id: "global-admin",
  label: "API_KEY operator",
  role: "admin",
  rateLimitRpm: 0,
  maxConcurrency: 0,
  legacy: true,
};

test("admin-session: create then verify round-trips the admin identity", () => {
  const created = createAdminSession(adminIdentity);
  assert.match(created.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const verified = verifyAdminSession(created.token);
  assert.ok(verified);
  assert.equal(verified.sub, adminIdentity.id);
  assert.equal(verified.label, adminIdentity.label);
  assert.equal(verified.role, "admin");
  assert.equal(verified.csrf, created.csrf);
  assert.equal(verified.exp, created.expiresAt / 1000);

  const identity = identityFromSession(verified);
  assert.equal(identity.id, adminIdentity.id);
  assert.equal(identity.role, "admin");
  assert.equal(identity.legacy, false);
});

test("admin-session: tampered tokens are rejected", () => {
  const created = createAdminSession(adminIdentity);
  const [body, signature] = created.token.split(".");

  assert.equal(verifyAdminSession(`${body}.${signature}x`), null);
  assert.equal(verifyAdminSession(`${body}x.${signature}`), null);
  assert.equal(verifyAdminSession("not-a-token"), null);
  assert.equal(verifyAdminSession(undefined), null);
  assert.equal(verifyAdminSession(""), null);
});

test("admin-session: expired sessions are rejected", () => {
  const created = createAdminSession(adminIdentity, 60);
  const justBefore = created.expiresAt / 1000 - 1;
  const justAfter = created.expiresAt / 1000 + 1;

  assert.ok(verifyAdminSession(created.token, justBefore));
  assert.equal(verifyAdminSession(created.token, justAfter), null);
});

test("admin-session: non-admin roles are never accepted", () => {
  const created = createAdminSession({
    ...adminIdentity,
    id: "plain-user",
    label: "plain",
    role: "user",
  });
  assert.equal(verifyAdminSession(created.token), null);
});

test("admin-session: CSRF validation compares exactly", () => {
  const created = createAdminSession(adminIdentity);
  const verified = verifyAdminSession(created.token);
  assert.ok(verified);

  assert.equal(validateCsrf(verified, created.csrf), true);
  assert.equal(validateCsrf(verified, `${created.csrf}x`), false);
  assert.equal(validateCsrf(verified, ""), false);
  assert.equal(validateCsrf(verified, undefined), false);
});

test("admin-session: cookie parsing ignores unrelated cookies", () => {
  const token = createAdminSession(adminIdentity).token;
  const header = `other=1; ${ADMIN_SESSION_COOKIE}=${token}; theme=dark`;
  assert.equal(readSessionCookie(header), token);
  assert.equal(readSessionCookie("other=1"), null);
  assert.equal(readSessionCookie(undefined), null);
  assert.equal(readSessionCookie(`${ADMIN_SESSION_COOKIE}=`), null);
});

test("admin-session: cookie attributes are hardened", () => {
  const secure = buildSessionCookie("token", 3600, true);
  assert.match(secure, new RegExp(`^${ADMIN_SESSION_COOKIE}=token`));
  assert.match(secure, /HttpOnly/);
  assert.match(secure, /SameSite=Strict/);
  assert.match(secure, /Path=\/admin/);
  assert.match(secure, /Max-Age=3600/);
  assert.match(secure, /Secure/);

  const plain = buildSessionCookie("token", 3600, false);
  assert.doesNotMatch(plain, /Secure/);

  const cleared = buildClearedSessionCookie(true);
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /HttpOnly/);
});
