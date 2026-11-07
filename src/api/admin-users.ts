/**
 * Admin REST surface for multi-user API keys.
 *
 * Mounted at /admin by server.ts, so the effective paths are
 * /admin/api/users*. Authentication is performed by the server middleware;
 * this router only enforces the admin role and validates payloads.
 */

import { Hono, type Context } from "hono";
import { getUserIdentity } from "../core/request-user.ts";
import { getUserQuotaSnapshot } from "../core/user-quota.ts";
import {
  createUser,
  getUserById,
  listUsers,
  revokeUser,
  rotateUserKey,
  updateUserLimits,
  type UserRole,
} from "../core/users.ts";

export const adminUsersApp = new Hono();

function jsonError(
  c: Context,
  status: 400 | 401 | 403 | 404,
  message: string,
): Response {
  const type =
    status === 401
      ? "authentication_error"
      : status === 403
        ? "permission_error"
        : status === 404
          ? "not_found_error"
          : "invalid_request_error";
  return c.json({ error: { type, message } }, status);
}

function parseLimit(
  value: unknown,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isInteger(value)
  ) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function parseRole(value: unknown): UserRole | undefined {
  if (value === undefined) return undefined;
  if (value !== "admin" && value !== "user") {
    throw new Error("role must be 'admin' or 'user'");
  }
  return value;
}

adminUsersApp.use("*", async (c, next) => {
  const identity = getUserIdentity(c);
  if (!identity) {
    return jsonError(c, 401, "Missing or invalid credentials");
  }
  if (identity.role !== "admin") {
    return jsonError(c, 403, "Admin role required");
  }
  await next();
});

adminUsersApp.get("/api/users", (c) => {
  const users = listUsers().map((user) => ({
    ...user,
    active_streams: getUserQuotaSnapshot(user.id).activeStreams,
  }));
  return c.json({ users });
});

adminUsersApp.post("/api/users", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!body || typeof body.label !== "string") {
    return jsonError(c, 400, "Field 'label' is required");
  }

  try {
    const role = parseRole(body.role);
    const rpm = parseLimit(body.rpm, "rpm");
    const concurrency = parseLimit(body.concurrency, "concurrency");
    const created = createUser(body.label, { role, rpm, concurrency });
    return c.json(
      {
        user: created.user,
        api_key: created.apiKey,
      },
      201,
    );
  } catch (error) {
    return jsonError(
      c,
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
});

adminUsersApp.patch("/api/users/:id", async (c) => {
  const id = c.req.param("id");
  const existing = getUserById(id);
  if (!existing) {
    return jsonError(c, 404, `Unknown user: ${id}`);
  }

  const body = (await c.req.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!body) {
    return jsonError(c, 400, "A JSON body is required");
  }

  try {
    const rpm = parseLimit(body.rpm, "rpm") ?? existing.rate_limit_rpm;
    const concurrency =
      parseLimit(body.concurrency, "concurrency") ?? existing.max_concurrency;
    const user = updateUserLimits(id, rpm, concurrency);
    return c.json({ user });
  } catch (error) {
    return jsonError(
      c,
      400,
      error instanceof Error ? error.message : String(error),
    );
  }
});

adminUsersApp.post("/api/users/:id/rotate", (c) => {
  const id = c.req.param("id");
  try {
    const rotated = rotateUserKey(id);
    return c.json({
      user: rotated.user,
      api_key: rotated.apiKey,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(c, message.startsWith("Unknown user") ? 404 : 400, message);
  }
});

adminUsersApp.delete("/api/users/:id", (c) => {
  const id = c.req.param("id");
  if (!revokeUser(id)) {
    return jsonError(c, 404, `Unknown or already revoked user: ${id}`);
  }
  return c.json({ success: true });
});
