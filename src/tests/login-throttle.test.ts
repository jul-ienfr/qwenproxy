import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  checkLoginThrottle,
  clearLoginFailures,
  LOGIN_FAILURE_WINDOW_MS,
  LOGIN_MAX_FAILURES,
  recordLoginFailure,
  resetLoginThrottleForTests,
} from "../admin/login-throttle.ts";

const NOW = 1_800_000_000_000;

beforeEach(() => {
  resetLoginThrottleForTests();
});

test("login-throttle: allows logins below the failure cap", () => {
  for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) {
    recordLoginFailure("10.0.0.1", NOW + i);
    assert.equal(checkLoginThrottle("10.0.0.1", NOW + i).allowed, true);
  }
});

test("login-throttle: locks out at the failure cap with a Retry-After", () => {
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
    recordLoginFailure("10.0.0.2", NOW + i);
  }

  const decision = checkLoginThrottle("10.0.0.2", NOW + LOGIN_MAX_FAILURES);
  assert.equal(decision.allowed, false);
  assert.ok((decision.retryAfterSec ?? 0) > 0);
  assert.ok((decision.retryAfterSec ?? 0) <= LOGIN_FAILURE_WINDOW_MS / 1000);
});

test("login-throttle: failures expire after the window", () => {
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
    recordLoginFailure("10.0.0.3", NOW);
  }
  assert.equal(checkLoginThrottle("10.0.0.3", NOW).allowed, false);
  assert.equal(
    checkLoginThrottle("10.0.0.3", NOW + LOGIN_FAILURE_WINDOW_MS + 1).allowed,
    true,
  );
});

test("login-throttle: a successful login clears the failure window", () => {
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
    recordLoginFailure("10.0.0.4", NOW);
  }
  assert.equal(checkLoginThrottle("10.0.0.4", NOW).allowed, false);

  clearLoginFailures("10.0.0.4");
  assert.equal(checkLoginThrottle("10.0.0.4", NOW).allowed, true);
});

test("login-throttle: buckets are isolated per source", () => {
  for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
    recordLoginFailure("10.0.0.5", NOW);
  }
  assert.equal(checkLoginThrottle("10.0.0.5", NOW).allowed, false);
  assert.equal(checkLoginThrottle("10.0.0.6", NOW).allowed, true);
});
