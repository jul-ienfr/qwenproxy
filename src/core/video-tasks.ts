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
