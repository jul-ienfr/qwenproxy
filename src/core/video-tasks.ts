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
 * In-flight generation requests that have passed the budget check but have not
 * created a task yet. Without this, N concurrent `wait` requests all observe
 * the same free slot and blow past the configured cap.
 */
const videoReservations = new Map<string, number>();
let totalVideoReservations = 0;

export interface VideoTaskReservation extends VideoTaskCapacity {
  release: () => void;
}

/**
 * Atomically check the budget and reserve one slot for an in-flight
 * generation. Always call `release()` once the upstream task (or failure) has
 * been recorded so the reservation does not linger.
 */
export function reserveVideoTaskCapacity(
  ownerId: string,
  limits: VideoTaskLimits,
): VideoTaskReservation {
  cleanupExpiredVideoTasks();

  const ownReserved = videoReservations.get(ownerId) ?? 0;
  const ownerActive = countActiveVideoTasks(ownerId) + ownReserved;
  if (limits.maxActivePerUser > 0 && ownerActive >= limits.maxActivePerUser) {
    return {
      allowed: false,
      reason: "per_user",
      limit: limits.maxActivePerUser,
      active: ownerActive,
      release: () => {},
    };
  }

  const globalActive = countActiveVideoTasks() + totalVideoReservations;
  if (limits.maxActive > 0 && globalActive >= limits.maxActive) {
    return {
      allowed: false,
      reason: "global",
      limit: limits.maxActive,
      active: globalActive,
      release: () => {},
    };
  }

  videoReservations.set(ownerId, ownReserved + 1);
  totalVideoReservations += 1;

  let released = false;
  return {
    allowed: true,
    release: () => {
      if (released) return;
      released = true;
      const remaining = (videoReservations.get(ownerId) ?? 1) - 1;
      if (remaining > 0) videoReservations.set(ownerId, remaining);
      else videoReservations.delete(ownerId);
      totalVideoReservations = Math.max(0, totalVideoReservations - 1);
    },
  };
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
  videoReservations.clear();
  totalVideoReservations = 0;
}
