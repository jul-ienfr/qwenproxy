/**
 * Persistent async task contract for specialized Qwen modes.
 *
 * A task re-enters the normal `/v1/chat/completions` pipeline with
 * `stream:false` on the loopback interface, so account selection, quotas,
 * cooldowns, retries and metrics stay identical to synchronous requests. The
 * task row itself is SQLite-local: status survives client disconnects and
 * process restarts, while active executions are cancelled by a restart and
 * reported as `interrupted`.
 */

import { randomUUID } from "node:crypto";
import { getDatabase } from "./database.ts";
import {
  extractArtifacts,
  type ExtractedArtifact,
  type SpecializedModelDefinition,
} from "./specialized-modes.ts";

export type SpecializedTaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface SpecializedTaskCitation {
  url: string;
  title?: string;
}

export interface SpecializedTaskResult {
  content: string;
  /** Validated source URLs found in the final content. */
  citations?: SpecializedTaskCitation[];
  artifacts: ExtractedArtifact[];
  usage?: unknown;
}

export interface SpecializedTaskError {
  code: string;
  message: string;
}

export interface SpecializedTask {
  id: string;
  object: "specialized.task";
  ownerId: string;
  model: string;
  mode: SpecializedModelDefinition["kind"];
  status: SpecializedTaskStatus;
  progress: number;
  createdAt: number;
  updatedAt: number;
  result: SpecializedTaskResult | null;
  error: SpecializedTaskError | null;
}

interface TaskRow {
  id: string;
  owner_id: string;
  model: string;
  mode: string;
  status: string;
  progress: number;
  created_at: number;
  updated_at: number;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
}

export const TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const activeRuns = new Map<
  string,
  { controller: AbortController; promise: Promise<void> }
>();

export type SpecializedTaskRunner = (input: {
  task: SpecializedTask;
  body: Record<string, unknown>;
  authorization?: string;
  origin: string;
  signal: AbortSignal;
}) => Promise<SpecializedTaskResult>;

let customRunner: SpecializedTaskRunner | undefined;

/** Test hook: replace the loopback completion call with an in-memory runner. */
export function setSpecializedTaskRunnerForTests(
  runner: SpecializedTaskRunner | undefined,
): void {
  customRunner = runner;
}

function ensureTable(): void {
  getDatabase().exec(`
    CREATE TABLE IF NOT EXISTS specialized_tasks (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      model TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      result_json TEXT,
      error_code TEXT,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_specialized_tasks_owner
      ON specialized_tasks(owner_id, created_at DESC);
  `);
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function toTask(row: TaskRow): SpecializedTask {
  return {
    id: row.id,
    object: "specialized.task",
    ownerId: row.owner_id,
    model: row.model,
    mode: row.mode as SpecializedModelDefinition["kind"],
    status: row.status as SpecializedTaskStatus,
    progress: row.progress,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    result: parseJson<SpecializedTaskResult>(row.result_json),
    error:
      row.error_code || row.error_message
        ? {
            code: row.error_code ?? "task_failed",
            message: row.error_message ?? "Task failed",
          }
        : null,
  };
}

export function createSpecializedTask(params: {
  ownerId: string;
  model: string;
  mode: SpecializedModelDefinition["kind"];
}): SpecializedTask {
  ensureTable();
  // Opportunistic retention: long-running servers never restart, so prune on
  // write as well as at startup.
  pruneSpecializedTasks();
  const now = Date.now();
  const id = `task_${randomUUID()}`;
  getDatabase()
    .prepare(
      `INSERT INTO specialized_tasks
        (id, owner_id, model, mode, status, progress, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)`,
    )
    .run(id, params.ownerId, params.model, params.mode, now, now);
  return {
    id,
    object: "specialized.task",
    ownerId: params.ownerId,
    model: params.model,
    mode: params.mode,
    status: "queued",
    progress: 0,
    createdAt: now,
    updatedAt: now,
    result: null,
    error: null,
  };
}

export function getSpecializedTask(
  id: string,
  ownerId?: string,
): SpecializedTask | undefined {
  ensureTable();
  const row = ownerId
    ? (getDatabase()
        .prepare("SELECT * FROM specialized_tasks WHERE id = ? AND owner_id = ?")
        .get(id, ownerId) as TaskRow | undefined)
    : (getDatabase()
        .prepare("SELECT * FROM specialized_tasks WHERE id = ?")
        .get(id) as TaskRow | undefined);
  return row ? toTask(row) : undefined;
}

export function listSpecializedTasks(
  ownerId: string,
  limit = 50,
): SpecializedTask[] {
  ensureTable();
  const rows = getDatabase()
    .prepare(
      "SELECT * FROM specialized_tasks WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(ownerId, Math.max(1, Math.min(200, limit))) as TaskRow[];
  return rows.map(toTask);
}

function updateTask(
  id: string,
  patch: {
    status?: SpecializedTaskStatus;
    progress?: number;
    result?: SpecializedTaskResult | null;
    error?: SpecializedTaskError | null;
  },
): void {
  ensureTable();
  const current = getSpecializedTask(id);
  if (!current) return;
  const status = patch.status ?? current.status;
  const progress = patch.progress ?? current.progress;
  const result = patch.result === undefined ? current.result : patch.result;
  const error = patch.error === undefined ? current.error : patch.error;
  getDatabase()
    .prepare(
      `UPDATE specialized_tasks
          SET status = ?, progress = ?, updated_at = ?,
              result_json = ?, error_code = ?, error_message = ?
        WHERE id = ?`,
    )
    .run(
      status,
      progress,
      Date.now(),
      result ? JSON.stringify(result) : null,
      error?.code ?? null,
      error?.message ?? null,
      id,
    );
}

function extractMessage(raw: any): string {
  const error = raw?.error;
  if (typeof error === "string") return error;
  if (error && typeof error.message === "string") return error.message;
  if (typeof raw?.message === "string") return raw.message;
  return "Specialized task failed";
}

function extractErrorCode(raw: any): string {
  const code = raw?.error?.code ?? raw?.code;
  return typeof code === "string" && code ? code : "task_failed";
}

function extractContent(raw: any): string {
  const content = raw?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) =>
        typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "",
      )
      .join("");
  }
  return "";
}

async function defaultRunner(input: {
  body: Record<string, unknown>;
  authorization?: string;
  origin: string;
  signal: AbortSignal;
}): Promise<SpecializedTaskResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (input.authorization) headers.authorization = input.authorization;

  const response = await fetch(`${input.origin}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...input.body, stream: false }),
    signal: input.signal,
  });

  const raw: any = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(extractMessage(raw)) as Error & {
      code?: string;
      statusCode?: number;
    };
    error.code = extractErrorCode(raw);
    error.statusCode = response.status;
    throw error;
  }

  const content = extractContent(raw);
  const artifacts = extractArtifacts(content);
  return {
    content,
    citations: artifacts.map((artifact) => ({
      url: artifact.url,
      ...(artifact.title ? { title: artifact.title } : {}),
    })),
    artifacts,
    ...(raw?.usage ? { usage: raw.usage } : {}),
  };
}

function withCitations(result: SpecializedTaskResult): SpecializedTaskResult {
  if (Array.isArray(result.citations)) return result;
  return {
    ...result,
    citations: result.artifacts.map((artifact) => ({
      url: artifact.url,
      ...(artifact.title ? { title: artifact.title } : {}),
    })),
  };
}

const TASK_TIMEOUT_MS = 30 * 60 * 1000;

async function runTask(
  task: SpecializedTask,
  body: Record<string, unknown>,
  authorization: string | undefined,
  origin: string,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TASK_TIMEOUT_MS);
  timer.unref?.();

  const run = async () => {
    updateTask(task.id, { status: "running", progress: 5 });
    try {
      const runner = customRunner ?? defaultRunner;
      const result = await runner({
        task,
        body,
        authorization,
        origin,
        signal: controller.signal,
      });
      const current = getSpecializedTask(task.id);
      if (current?.status === "cancelled") return;
      updateTask(task.id, {
        status: "succeeded",
        progress: 100,
        result: withCitations(result),
        error: null,
      });
    } catch (error: any) {
      const current = getSpecializedTask(task.id);
      if (current?.status === "cancelled") return;
      const aborted = controller.signal.aborted || error?.name === "AbortError";
      updateTask(task.id, {
        status: aborted ? "cancelled" : "failed",
        progress: 100,
        error: aborted
          ? { code: "task_cancelled", message: "Task cancelled" }
          : {
              code: typeof error?.code === "string" ? error.code : "task_failed",
              message:
                error instanceof Error ? error.message : String(error ?? "Task failed"),
            },
      });
    } finally {
      clearTimeout(timer);
      activeRuns.delete(task.id);
    }
  };

  const promise = run();
  activeRuns.set(task.id, { controller, promise });
}

export function launchSpecializedTask(params: {
  task: SpecializedTask;
  body: Record<string, unknown>;
  authorization?: string;
  origin: string;
}): void {
  void runTask(params.task, params.body, params.authorization, params.origin);
}

export function cancelSpecializedTask(
  id: string,
  ownerId?: string,
): SpecializedTask | undefined {
  const task = getSpecializedTask(id, ownerId);
  if (!task) return undefined;
  if (task.status === "queued" || task.status === "running") {
    activeRuns.get(id)?.controller.abort();
    updateTask(id, {
      status: "cancelled",
      progress: 100,
      error: { code: "task_cancelled", message: "Task cancelled" },
    });
  }
  return getSpecializedTask(id, ownerId);
}

/** Test helper: wait for the background execution to settle. */
export async function awaitSpecializedTask(id: string): Promise<void> {
  await activeRuns.get(id)?.promise;
}

/** A restart cannot resume an in-flight loopback request. */
export function recoverInterruptedSpecializedTasks(): number {
  ensureTable();
  const now = Date.now();
  const result = getDatabase()
    .prepare(
      `UPDATE specialized_tasks
          SET status = 'failed', progress = 100, updated_at = ?,
              error_code = 'interrupted', error_message = 'Task interrupted by a process restart'
        WHERE status IN ('queued', 'running')`,
    )
    .run(now);
  return result.changes;
}

export function pruneSpecializedTasks(olderThanMs = TASK_RETENTION_MS): number {
  ensureTable();
  const cutoff = Date.now() - olderThanMs;
  const result = getDatabase()
    .prepare("DELETE FROM specialized_tasks WHERE updated_at < ?")
    .run(cutoff);
  return result.changes;
}

/** Initialize persistence once at server startup. */
export function initializeSpecializedTasks(): void {
  ensureTable();
  const interrupted = recoverInterruptedSpecializedTasks();
  pruneSpecializedTasks();
  if (interrupted > 0) {
    console.warn(
      `⚠️ [Tasks] Marked ${interrupted} interrupted specialized task(s) as failed`,
    );
  }
}
