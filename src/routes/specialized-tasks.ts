/**
 * Async task surface for specialized Qwen modes.
 *
 * Long-running research/slides/artifact jobs must not hold an HTTP connection
 * open. A task reuses the normal completions pipeline in the background and is
 * polled through this small CRUD surface.
 */

import { Hono } from "hono";
import { config } from "../core/config.ts";
import {
  NotFoundError,
  SpecializedTaskLimitError,
  ValidationError,
} from "../core/errors.ts";
import { getUserIdentity } from "../core/request-user.ts";
import {
  resolveSpecializedModel,
  specializedCapabilityError,
} from "../core/specialized-modes.ts";
import {
  cancelSpecializedTask,
  checkSpecializedTaskCapacity,
  createSpecializedTask,
  getSpecializedTask,
  launchSpecializedTask,
  listSpecializedTasks,
  type SpecializedTask,
} from "../core/specialized-tasks.ts";
import { sendOpenAIError } from "../api/error-helpers.ts";

const app = new Hono();

function ownerOf(c: Parameters<typeof getUserIdentity>[0]): string {
  return getUserIdentity(c)?.id ?? "legacy";
}

/**
 * The worker must call this same process over loopback. Never derive the
 * origin from the request `Host` header: it is attacker-controlled and the
 * call carries the caller's Authorization header.
 */
function taskOrigin(): string {
  const host = config.server.host;
  const connectHost =
    host === "0.0.0.0" || host === "::" || host === "[::]" || !host
      ? "127.0.0.1"
      : host;
  const formattedHost =
    connectHost.includes(":") && !connectHost.startsWith("[")
      ? `[${connectHost}]`
      : connectHost;
  return `http://${formattedHost}:${config.server.port}`;
}

function publicTask(task: SpecializedTask): Record<string, unknown> {
  return {
    id: task.id,
    object: task.object,
    model: task.model,
    mode: task.mode,
    status: task.status,
    progress: task.progress,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    result: task.result,
    error: task.error,
  };
}

app.post("/v1/tasks", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      // Hono surfaces a SyntaxError for a malformed body, which the generic
      // classifier would report as an internal 500. A bad request body is a
      // client error and must stay a 400 like the object-shape check below.
      throw new ValidationError("Request body must be valid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ValidationError("Request body must be a JSON object");
    }
    const record = body as Record<string, unknown>;
    const model = typeof record.model === "string" ? record.model.trim() : "";
    const definition = resolveSpecializedModel(model);
    if (!definition) {
      return sendOpenAIError(
        c,
        specializedCapabilityError(
          `Model '${model || "<missing>"}' is not a specialized async mode. Use /v1/chat/completions for normal models.`,
          "capability_unavailable",
        ),
      );
    }

    // The task body is replayed against the chat pipeline, which requires a
    // non-empty `messages` array. Reject bad shapes synchronously instead of
    // accepting a 202 that can only fail asynchronously.
    if (!Array.isArray(record.messages) || record.messages.length === 0) {
      const error = new ValidationError(
        "Field 'messages' must be a non-empty array",
      );
      error.param = "messages";
      throw error;
    }

    const ownerId = ownerOf(c);
    const capacity = checkSpecializedTaskCapacity(
      ownerId,
      config.specializedTasks,
    );
    if (!capacity.allowed) {
      const scope =
        capacity.reason === "global" ? "this proxy" : "this API key";
      throw new SpecializedTaskLimitError(
        `Too many active specialized tasks for ${scope} (limit ${capacity.limit}). Wait for a running task to finish or cancel one with DELETE /v1/tasks/{taskId}.`,
      );
    }

    const task = createSpecializedTask({
      ownerId,
      model: definition.id,
      mode: definition.kind,
    });
    launchSpecializedTask({
      task,
      body: record,
      // Forward every accepted credential form: the outer request may have
      // authenticated with any of them, and the inner loopback call must be
      // able to do the same or it would fail with 401.
      authorization: c.req.header("authorization"),
      apiKey: c.req.header("x-api-key"),
      googApiKey: c.req.header("x-goog-api-key"),
      researchMode: c.req.header("x-qwenproxy-research-mode"),
      origin: taskOrigin(),
    });
    return c.json(publicTask(task), 202);
  } catch (error) {
    return sendOpenAIError(c, error);
  }
});

app.get("/v1/tasks", (c) => {
  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
  return c.json({
    object: "list",
    data: listSpecializedTasks(ownerOf(c), limit).map(publicTask),
  });
});

app.get("/v1/tasks/:taskId", (c) => {
  try {
    const id = c.req.param("taskId");
    const task = getSpecializedTask(id, ownerOf(c));
    if (!task) throw new NotFoundError(`Specialized task not found: ${id}`);
    return c.json(publicTask(task));
  } catch (error) {
    return sendOpenAIError(c, error);
  }
});

app.delete("/v1/tasks/:taskId", (c) => {
  try {
    const id = c.req.param("taskId");
    const task = cancelSpecializedTask(id, ownerOf(c));
    if (!task) throw new NotFoundError(`Specialized task not found: ${id}`);
    return c.json(publicTask(task));
  } catch (error) {
    return sendOpenAIError(c, error);
  }
});

export { app };
