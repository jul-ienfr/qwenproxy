import test from "node:test";
import assert from "node:assert/strict";

import {
  VIDEO_TASK_TTL_MS,
  cleanupExpiredVideoTasks,
  createVideoTask,
  getVideoTask,
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
