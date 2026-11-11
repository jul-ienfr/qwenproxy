/**
 * In-memory registry for prompt-driven video generation tasks.
 *
 * Tasks live only for the lifetime of the process (the upstream poll window is
 * short) and are scoped to the identity that created them: a task id is not a
 * capability, so another API key must not be able to read or poll it.
 */

export type MediaTaskStatus = "pending" | "running" | "completed" | "failed";

export interface VideoTaskRecord {
  taskId: string;
  ownerId: string;
  accountId: string;
  chatId: string;
  createdAt: number;
  status: MediaTaskStatus;
  videoUrl?: string;
}

export const VIDEO_TASK_TTL_MS = 60 * 60_000;

const videoTasks = new Map<string, VideoTaskRecord>();

export interface VideoTaskLimits {
  /** 0 disables the per-owner cap. */
  maxActivePerUser: number;
  /** 0 disables the global per-instance cap. */
  maxActive: number;
}

export interface VideoTaskCapacity {
  allowed: boolean;
  reason?: "per_user" | "global";
  /** The cap that was hit. */
  limit?: number;
  /** Active tasks counted at the time of the check. */
  active?: number;
}

/** Active means work that can still be polled upstream: pending or running. */
export function countActiveVideoTasks(ownerId?: string): number {
  cleanupExpiredVideoTasks();
  let active = 0;
  for (const entry of videoTasks.values()) {
    if (entry.status !== "pending" && entry.status !== "running") continue;
    if (ownerId !== undefined && entry.ownerId !== ownerId) continue;
    active++;
  }
  return active;
}

/**
 * Budget check before starting an expensive upstream video job. Terminal tasks
 * are retained for status polling but do not consume a slot.
 */
export function checkVideoTaskCapacity(
  ownerId: string,
  limits: VideoTaskLimits,
): VideoTaskCapacity {
  if (limits.maxActivePerUser > 0) {
    const active = countActiveVideoTasks(ownerId);
    if (active >= limits.maxActivePerUser) {
      return {
        allowed: false,
        reason: "per_user",
        limit: limits.maxActivePerUser,
        active,
      };
    }
  }
  if (limits.maxActive > 0) {
    const active = countActiveVideoTasks();
    if (active >= limits.maxActive) {
      return {
        allowed: false,
        reason: "global",
        limit: limits.maxActive,
        active,
      };
    }
  }
  return { allowed: true };
}

/** Drop entries older than the retention window. Returns how many were pruned. */
export function cleanupExpiredVideoTasks(now = Date.now()): number {
  const cutoff = now - VIDEO_TASK_TTL_MS;
  let removed = 0;
  for (const [taskId, entry] of videoTasks) {
    if (entry.createdAt < cutoff) {
      videoTasks.delete(taskId);
      removed++;
    }
  }
  return removed;
}

export function createVideoTask(
  record: Omit<VideoTaskRecord, "createdAt"> & { createdAt?: number },
): VideoTaskRecord {
  const entry: VideoTaskRecord = {
    ...record,
    createdAt: record.createdAt ?? Date.now(),
  };
  videoTasks.set(entry.taskId, entry);
  return entry;
}

/**
 * Look up a task. When `ownerId` is provided, a task owned by a different
 * identity is reported as missing so ownership cannot be probed.
 */
export function getVideoTask(
  taskId: string,
  ownerId?: string,
): VideoTaskRecord | undefined {
  const entry = videoTasks.get(taskId);
  if (!entry) return undefined;
  if (ownerId !== undefined && entry.ownerId !== ownerId) return undefined;
  return entry;
}

export function updateVideoTask(
  taskId: string,
  patch: Partial<Pick<VideoTaskRecord, "status" | "videoUrl">>,
): VideoTaskRecord | undefined {
  const entry = videoTasks.get(taskId);
  if (!entry) return undefined;
  if (patch.status !== undefined) entry.status = patch.status;
  if (patch.videoUrl !== undefined) entry.videoUrl = patch.videoUrl;
  return entry;
}

/** Test helper: clear all in-memory video tasks. */
export function resetVideoTasksForTests(): void {
  videoTasks.clear();
}
