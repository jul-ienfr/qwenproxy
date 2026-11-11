import test from "node:test";
import assert from "node:assert/strict";

import {
  VIDEO_TASK_TTL_MS,
  checkVideoTaskCapacity,
  cleanupExpiredVideoTasks,
  countActiveVideoTasks,
  createVideoTask,
  getVideoTask,
  reserveVideoTaskCapacity,
  resetVideoTasksForTests,
  updateVideoTask,
} from "../core/video-tasks.ts";

function seed(taskId: string, ownerId: string, createdAt?: number) {
  return createVideoTask({
    taskId,
    ownerId,
    accountId: "account-1",
    chatId: "chat-1",
    status: "pending",
    createdAt,
  });
}

test("video tasks: scoped lookups hide another owner's task", () => {
  resetVideoTasksForTests();
  seed("task_a", "owner-a");

  assert.equal(getVideoTask("task_a", "owner-a")?.taskId, "task_a");
  assert.equal(getVideoTask("task_a", "owner-b"), undefined);
  assert.equal(getVideoTask("task_a")?.taskId, "task_a");

  resetVideoTasksForTests();
});

test("video tasks: updateVideoTask patches status and keeps the video URL", () => {
  resetVideoTasksForTests();
  seed("task_b", "owner-a");

  const running = updateVideoTask("task_b", { status: "running" });
  assert.equal(running?.status, "running");

  const done = updateVideoTask("task_b", {
    status: "completed",
    videoUrl: "https://example.com/video.mp4",
  });
  assert.equal(done?.status, "completed");
  assert.equal(done?.videoUrl, "https://example.com/video.mp4");

  // A later status without a URL must not erase the known URL.
  const stillDone = updateVideoTask("task_b", { status: "completed" });
  assert.equal(stillDone?.videoUrl, "https://example.com/video.mp4");

  assert.equal(updateVideoTask("missing", { status: "failed" }), undefined);

  resetVideoTasksForTests();
});

test("video tasks: cleanup drops only entries older than the TTL", () => {
  resetVideoTasksForTests();
  const now = 10_000_000;
  seed("old", "owner-a", now - VIDEO_TASK_TTL_MS - 1);
  seed("fresh", "owner-a", now - 1000);

  assert.equal(cleanupExpiredVideoTasks(now), 1);
  assert.equal(getVideoTask("old"), undefined);
  assert.ok(getVideoTask("fresh"));

  resetVideoTasksForTests();
});

test("video tasks: terminal tasks do not consume an active slot", () => {
  resetVideoTasksForTests();
  seed("pending", "owner-a");
  seed("running", "owner-a");
  seed("done", "owner-a");
  updateVideoTask("running", { status: "running" });
  updateVideoTask("done", { status: "completed" });

  assert.equal(countActiveVideoTasks("owner-a"), 2);
  assert.equal(countActiveVideoTasks(), 2);

  resetVideoTasksForTests();
});

test("video tasks: per-user and global caps reject new active work", () => {
  resetVideoTasksForTests();
  seed("task-a1", "owner-a");
  seed("task-a2", "owner-a");
  seed("task-b1", "owner-b");
  updateVideoTask("task-a2", { status: "running" });

  const perUser = checkVideoTaskCapacity("owner-a", {
    maxActivePerUser: 2,
    maxActive: 10,
  });
  assert.equal(perUser.allowed, false);
  assert.equal(perUser.reason, "per_user");

  assert.equal(
    checkVideoTaskCapacity("owner-b", {
      maxActivePerUser: 2,
      maxActive: 10,
    }).allowed,
    true,
  );

  const global = checkVideoTaskCapacity("owner-c", {
    maxActivePerUser: 2,
    maxActive: 3,
  });
  assert.equal(global.allowed, false);
  assert.equal(global.reason, "global");

  updateVideoTask("task-a1", { status: "completed" });
  assert.equal(
    checkVideoTaskCapacity("owner-a", {
      maxActivePerUser: 2,
      maxActive: 10,
    }).allowed,
    true,
  );

  resetVideoTasksForTests();
});

test("video tasks: zero caps disable the budget", () => {
  resetVideoTasksForTests();
  seed("task-a1", "owner-a");

  assert.equal(
    checkVideoTaskCapacity("owner-a", {
      maxActivePerUser: 0,
      maxActive: 0,
    }).allowed,
    true,
  );

  resetVideoTasksForTests();
});

test("video tasks: reservations close the concurrent-start race", () => {
  resetVideoTasksForTests();
  const limits = { maxActivePerUser: 2, maxActive: 2 };

  const first = reserveVideoTaskCapacity("owner-a", limits);
  const second = reserveVideoTaskCapacity("owner-a", limits);
  const third = reserveVideoTaskCapacity("owner-a", limits);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, false);
  assert.equal(third.reason, "per_user");

  // The global budget counts reservations from every owner.
  const other = reserveVideoTaskCapacity("owner-b", limits);
  assert.equal(other.allowed, false);
  assert.equal(other.reason, "global");

  // Releasing is idempotent and frees the slot for another owner.
  first.release();
  first.release();
  const otherRetry = reserveVideoTaskCapacity("owner-b", limits);
  assert.equal(otherRetry.allowed, true);
  otherRetry.release();

  // Once the real task exists it keeps consuming the budget after release.
  createVideoTask({
    taskId: "created",
    ownerId: "owner-a",
    accountId: "account-1",
    chatId: "chat-1",
    status: "pending",
  });
  second.release();
  const next = reserveVideoTaskCapacity("owner-a", limits);
  assert.equal(next.allowed, true);

  next.release();
  resetVideoTasksForTests();
});

test("video tasks: zero caps keep reservations unlimited", () => {
  resetVideoTasksForTests();
  const unlimited = { maxActivePerUser: 0, maxActive: 0 };
  const reservations = Array.from({ length: 12 }, () =>
    reserveVideoTaskCapacity("owner-a", unlimited),
  );
  assert.ok(reservations.every((reservation) => reservation.allowed));
  for (const reservation of reservations) reservation.release();
  resetVideoTasksForTests();
});
