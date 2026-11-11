import type { Context } from "hono";
import { config } from "../core/config.ts";
import {
  generateVideo,
  isSupportedMediaSize,
  MEDIA_SIZE_OPTIONS,
  pollVideoTask,
  supportsPromptMediaGeneration,
} from "../services/media-generation.ts";
import { logger } from "../core/logger.ts";
import { getUserIdentity } from "../core/request-user.ts";
import { createError, sendOpenAIError } from "../api/error-helpers.ts";
import { NotFoundError, ValidationError } from "../core/errors.ts";
import {
  checkVideoTaskCapacity,
  cleanupExpiredVideoTasks,
  createVideoTask,
  getVideoTask,
  updateVideoTask,
} from "../core/video-tasks.ts";

const DEFAULT_SIZE = "16:9";

interface VideosGenerationsRequest {
  model?: unknown;
  prompt?: unknown;
  size?: unknown;
  wait?: unknown;
}

function ownerOf(c: Context): string {
  return getUserIdentity(c)?.id ?? "legacy";
}

function validationError(message: string, param: string): ValidationError {
  const err = new ValidationError(message);
  err.param = param;
  return err;
}

export async function videosGenerations(c: Context): Promise<Response> {
  cleanupExpiredVideoTasks();

  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return sendOpenAIError(c, new ValidationError("Request body must be valid JSON"));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return sendOpenAIError(
      c,
      new ValidationError("Request body must be a JSON object"),
    );
  }
  const body = parsed as VideosGenerationsRequest;

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return sendOpenAIError(
      c,
      validationError("`prompt` must be a non-empty string", "prompt"),
    );
  }

  const size = body.size === undefined ? DEFAULT_SIZE : body.size;
  if (!isSupportedMediaSize(size)) {
    return sendOpenAIError(
      c,
      validationError(
        `\`size\` must be one of: ${MEDIA_SIZE_OPTIONS.join(", ")}`,
        "size",
      ),
    );
  }

  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : "";
  if (!model) {
    return sendOpenAIError(
      c,
      validationError("`model` must be the model selected by the client", "model"),
    );
  }
  if (!supportsPromptMediaGeneration(model, "video")) {
    return sendOpenAIError(
      c,
      validationError(
        `Model \`${model}\` requires a reference image and is not available through prompt-only video generation yet`,
        "model",
      ),
    );
  }
  const wait = body.wait !== false;
  const ownerId = ownerOf(c);

  const capacity = checkVideoTaskCapacity(ownerId, config.videos);
  if (!capacity.allowed) {
    return sendOpenAIError(
      c,
      createError(
        429,
        capacity.reason === "per_user"
          ? `Too many active video tasks for this API key (limit ${capacity.limit}); wait for one to finish`
          : `Too many active video tasks on this instance (limit ${capacity.limit}); try again later`,
      ),
    );
  }

  logger.info("Video generation request", {
    model,
    size,
    wait,
  });

  try {
    const result = await generateVideo({
      model,
      prompt,
      size,
      waitForCompletion: wait,
      signal: c.req.raw.signal,
    });

    const created = Math.floor(Date.now() / 1000);

    // The upstream can return the video URL inline, without a task id.
    if (!result.task_id) {
      if (result.status === "completed" && result.video_url) {
        return c.json({
          created,
          task_id: "",
          status: "completed",
          data: [{ url: result.video_url }],
        });
      }
      return sendOpenAIError(
        c,
        new Error("Video generation returned no task or video URL"),
        500,
      );
    }

    createVideoTask({
      taskId: result.task_id,
      ownerId,
      accountId: result.accountId,
      chatId: result.chatId,
      status: result.status,
      videoUrl: result.video_url,
    });

    if (result.status === "failed") {
      logger.error("Video generation task failed", { taskId: result.task_id });
      return sendOpenAIError(c, new Error("Video generation failed"), 500);
    }

    if (result.status === "completed") {
      return c.json({
        created,
        task_id: result.task_id,
        status: "completed",
        data: [{ url: result.video_url }],
      });
    }

    // wait=false, or the upstream poll window elapsed before completion.
    return c.json({
      created,
      task_id: result.task_id,
      status: result.status,
    });
  } catch (error) {
    if (c.req.raw.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    logger.error("Video generation failed", {
      model,
      error: error instanceof Error ? error.message : String(error),
    });
    return sendOpenAIError(c, error, 500);
  }
}

export async function videoTaskStatus(c: Context): Promise<Response> {
  cleanupExpiredVideoTasks();

  const taskId = c.req.param("taskId");
  if (!taskId) {
    return sendOpenAIError(c, new NotFoundError("Video task not found"));
  }

  // Scope lookups to the caller: another API key must not see this task even
  // when it knows the id.
  const entry = getVideoTask(taskId, ownerOf(c));
  if (!entry) {
    return sendOpenAIError(c, new NotFoundError(`Video task not found: ${taskId}`));
  }

  const wait = c.req.query("wait") === "true";

  try {
    const isTerminal = entry.status === "completed" || entry.status === "failed";
    if (!isTerminal) {
      // Refresh from upstream on every poll. `wait=true` blocks until a
      // terminal status (or the internal timeout); the default is a single
      // non-blocking check so async tasks progress instead of staying
      // "pending" forever after a wait=false generation.
      const result = await pollVideoTask({
        taskId,
        accountId: entry.accountId,
        once: !wait,
        signal: c.req.raw.signal,
      });
      updateVideoTask(taskId, {
        status: result.status,
        ...(result.video_url ? { videoUrl: result.video_url } : {}),
      });
      if (result.status === "failed") {
        logger.error("Video task failed", {
          taskId,
          error: result.error ?? "unknown",
        });
      }
    }

    return c.json({
      task_id: taskId,
      status: entry.status,
      video_url: entry.videoUrl ?? null,
      created: Math.floor(entry.createdAt / 1000),
    });
  } catch (error) {
    if (c.req.raw.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    logger.error("Video task status check failed", {
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    return sendOpenAIError(c, error, 500);
  }
}
