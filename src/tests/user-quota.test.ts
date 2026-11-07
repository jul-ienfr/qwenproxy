import test from "node:test";
import assert from "node:assert/strict";
import type { UserIdentity } from "../core/users.ts";
import {
  acquireUserStream,
  checkUserRequest,
  getUserQuotaSnapshot,
  recordUserError,
  withUserStreamSlot,
} from "../core/user-quota.ts";

let sequence = 0;

function identity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  sequence++;
  return {
    id: `quota-test-${sequence}`,
    label: `quota-test-${sequence}`,
    role: "user",
    rateLimitRpm: 2,
    maxConcurrency: 1,
    legacy: false,
    ...overrides,
  };
}

test("quota: RPM uses a sliding 60s window", () => {
  const user = identity({ rateLimitRpm: 2 });
  assert.equal(checkUserRequest(user, 1_000).allowed, true);
  assert.equal(checkUserRequest(user, 2_000).allowed, true);

  const denied = checkUserRequest(user, 3_000);
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "rpm");
  assert.ok((denied.retryAfterSec ?? 0) >= 1);

  // The first two timestamps fall outside the 60s window at t=61s.
  assert.equal(checkUserRequest(user, 61_001).allowed, true);
});

test("quota: zero RPM means unlimited", () => {
  const user = identity({ rateLimitRpm: 0 });
  for (let i = 0; i < 100; i++) {
    assert.equal(checkUserRequest(user).allowed, true);
  }
});

test("quota: concurrency slots are exclusive and release exactly once", () => {
  const user = identity({ rateLimitRpm: 0, maxConcurrency: 1 });
  const first = acquireUserStream(user);
  assert.ok(first);
  assert.equal(acquireUserStream(user), null);
  assert.equal(getUserQuotaSnapshot(user.id).activeStreams, 1);

  first!();
  assert.equal(getUserQuotaSnapshot(user.id).activeStreams, 0);

  const second = acquireUserStream(user);
  assert.ok(second);
  second!();
  second!();
  assert.equal(getUserQuotaSnapshot(user.id).activeStreams, 0);
});

test("quota: legacy and admin identities bypass limits", () => {
  const legacy = identity({ legacy: true, rateLimitRpm: 1, maxConcurrency: 1 });
  const admin = identity({ role: "admin", rateLimitRpm: 1, maxConcurrency: 1 });

  for (const user of [legacy, admin]) {
    for (let i = 0; i < 5; i++) {
      assert.equal(checkUserRequest(user).allowed, true);
    }
    const releases = [acquireUserStream(user), acquireUserStream(user)];
    assert.ok(releases.every(Boolean));
    releases.forEach((release) => release!());
  }
});

test("quota: errors are counted for the admin snapshot", () => {
  const user = identity();
  recordUserError(user);
  recordUserError(user);
  assert.equal(getUserQuotaSnapshot(user.id).errors, 2);
});

test("quota: stream wrapper releases when the body is fully consumed", async () => {
  const user = identity({ maxConcurrency: 1 });
  const release = acquireUserStream(user)!;
  let releases = 0;

  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a"));
        controller.enqueue(new TextEncoder().encode("b"));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

  const wrapped = withUserStreamSlot(response, () => {
    releases++;
    release();
  });

  assert.equal(await wrapped.text(), "ab");
  assert.equal(releases, 1);
  assert.equal(getUserQuotaSnapshot(user.id).activeStreams, 0);
});

test("quota: stream wrapper releases on client cancellation", async () => {
  const user = identity({ maxConcurrency: 1 });
  const release = acquireUserStream(user)!;
  let releases = 0;

  const response = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("tick"));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

  const wrapped = withUserStreamSlot(response, () => {
    releases++;
    release();
  });

  const reader = wrapped.body!.getReader();
  await reader.read();
  await reader.cancel("client left");
  assert.equal(releases, 1);
  assert.equal(getUserQuotaSnapshot(user.id).activeStreams, 0);
});

test("quota: stream wrapper releases on body errors", async () => {
  const user = identity({ maxConcurrency: 1 });
  const release = acquireUserStream(user)!;
  let releases = 0;

  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error("upstream exploded"));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

  const wrapped = withUserStreamSlot(response, () => {
    releases++;
    release();
  });

  await assert.rejects(wrapped.text(), /upstream exploded/);
  assert.equal(releases, 1);
  assert.equal(getUserQuotaSnapshot(user.id).activeStreams, 0);
});

test("quota: wrapper releases immediately for bodyless responses", () => {
  let releases = 0;
  const response = withUserStreamSlot(new Response(null, { status: 204 }), () => {
    releases++;
  });
  assert.equal(response.status, 204);
  assert.equal(releases, 1);
});
