/**
 * Authenticated web administration dashboard.
 *
 * Served by the existing Hono process: static HTML/CSS/JS plus JSON/SSE
 * endpoints under /admin/api. The dashboard makes no upstream call for its
 * overview, so it remains usable when Qwen is unavailable.
 */

import { Hono, type Context } from "hono";
import { config } from "../core/config.ts";
import {
  createAdminSession,
  DEFAULT_SESSION_TTL_SECONDS,
  buildClearedSessionCookie,
  buildSessionCookie,
  isSecureRequest,
  readSessionCookie,
  verifyAdminSession,
} from "../core/admin-session.ts";
import {
  identityErrorMessage,
  resolveIdentity,
} from "../core/auth-identity.ts";
import { getUserIdentity } from "../core/request-user.ts";
import { getServerLogHistory, subscribeServerLogStream } from "../core/server-log-buffer.ts";
import { loadModelsWithVariants } from "../api/models.ts";
import { recordAudit, listAudit } from "../core/admin-audit.ts";
import { adminJsonError, revalidateAdminSession, sessionCredentialHash } from "./auth.ts";
import {
  checkLoginThrottle,
  clearLoginFailures,
  recordLoginFailure,
} from "./login-throttle.ts";
import { accountsApp } from "./accounts-api.ts";
import { buildOverview } from "./overview.ts";
import { redactLogHistory, redactLogEntry } from "./logs.ts";
import { applySettings, listSettings } from "./settings.ts";
import {
  getModelMappingState,
  parseModelMap,
  resetModelMappings,
  saveModelMappings,
  validateModelMappings,
  type ModelMappingState,
} from "../core/model-mapping.ts";
import { ADMIN_CSS, ADMIN_HTML, ADMIN_JS } from "./ui.ts";

export const adminDashboardApp = new Hono();

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function secureCookie(c: Context): boolean {
  return isSecureRequest(c.req.url, c.req.header("x-forwarded-proto"));
}

function actor(c: Context): string {
  return getUserIdentity(c)?.label || "unknown";
}

async function readJson(
  c: Context,
): Promise<Record<string, unknown> | null> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

/**
 * Source address used for failed-login throttling. Forwarding headers are
 * deliberately ignored: they are caller-controlled unless a trusted proxy
 * strips them, and honoring them here would let an attacker rotate buckets.
 * Direct embedded deployments without a socket share one bucket.
 */
function loginThrottleKey(c: Context): string {
  const socket = (
    c.env as
      | { incoming?: { socket?: { remoteAddress?: string } } }
      | undefined
  )?.incoming?.socket;
  const address =
    typeof socket?.remoteAddress === "string" ? socket.remoteAddress.trim() : "";
  return address || "unknown";
}

function serializeModelMappings(state: ModelMappingState) {
  return {
    mappings: Object.fromEntries(
      state.mappings.map((entry) => [entry.alias, entry.target]),
    ),
    entries: state.mappings,
    fallback: state.fallback,
    source: state.source,
    updatedAt: state.updatedAt,
  };
}

function modelMappingTarget(state: ModelMappingState): string {
  const aliases = state.mappings.map((entry) => entry.alias);
  const parts = [...aliases];
  if (state.fallback) parts.push("*");
  return parts.join(",") || "none";
}

// ─── Static UI ──────────────────────────────────────────────────────────────

adminDashboardApp.get("/", (c) => {
  return c.body(ADMIN_HTML, 200, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
  });
});

adminDashboardApp.get("/assets/admin.css", (c) => {
  return c.body(ADMIN_CSS, 200, {
    "Content-Type": "text/css; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
});

adminDashboardApp.get("/assets/admin.js", (c) => {
  return c.body(ADMIN_JS, 200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
});

// ─── Session ────────────────────────────────────────────────────────────────

adminDashboardApp.post("/api/session", async (c) => {
  const throttleKey = loginThrottleKey(c);
  const throttle = checkLoginThrottle(throttleKey);
  if (!throttle.allowed) {
    c.header("Retry-After", String(throttle.retryAfterSec ?? 1));
    return adminJsonError(
      c,
      429,
      "Too many failed login attempts; try again later",
    );
  }

  const body = await readJson(c);
  const apiKey =
    body && typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const resolution = resolveIdentity(apiKey ? [apiKey] : []);

  if (resolution.error || !resolution.identity) {
    recordLoginFailure(throttleKey);
    return adminJsonError(
      c,
      401,
      identityErrorMessage(resolution.error ?? "invalid"),
    );
  }
  if (resolution.identity.role !== "admin") {
    recordLoginFailure(throttleKey);
    return adminJsonError(c, 403, "Admin role required");
  }
  clearLoginFailures(throttleKey);

  const session = createAdminSession(
    resolution.identity,
    DEFAULT_SESSION_TTL_SECONDS,
    { keyHash: sessionCredentialHash(resolution.identity, apiKey) },
  );
  c.header(
    "Set-Cookie",
    buildSessionCookie(
      session.token,
      DEFAULT_SESSION_TTL_SECONDS,
      secureCookie(c),
    ),
  );
  recordAudit(
    resolution.identity.label,
    "session.login",
    resolution.identity.id,
    "ok",
  );

  return c.json({
    user: {
      id: resolution.identity.id,
      label: resolution.identity.label,
      role: resolution.identity.role,
    },
    csrf: session.csrf,
    expiresAt: session.expiresAt,
  });
});

adminDashboardApp.get("/api/session", (c) => {
  const session = verifyAdminSession(
    readSessionCookie(c.req.header("cookie")),
  );
  if (!session) {
    return adminJsonError(c, 401, "Admin session required");
  }
  const identity = revalidateAdminSession(session);
  if (!identity) {
    c.header("Set-Cookie", buildClearedSessionCookie(secureCookie(c)));
    return adminJsonError(
      c,
      401,
      "Admin session no longer valid; sign in again",
    );
  }
  return c.json({
    user: {
      id: identity.id,
      label: identity.label,
      role: identity.role,
    },
    csrf: session.csrf,
    expiresAt: session.exp * 1000,
  });
});

adminDashboardApp.delete("/api/session", (c) => {
  const session = verifyAdminSession(
    readSessionCookie(c.req.header("cookie")),
  );
  c.header("Set-Cookie", buildClearedSessionCookie(secureCookie(c)));
  if (session) {
    recordAudit(session.label, "session.logout", session.sub, "ok");
  }
  return c.json({ success: true });
});

// ─── Overview / accounts ────────────────────────────────────────────────────

adminDashboardApp.get("/api/overview", (c) => {
  return c.json(buildOverview());
});

adminDashboardApp.route("/api/accounts", accountsApp);

// ─── Users are served by admin-users.ts, mounted next to this app ───────────

// ─── Settings ───────────────────────────────────────────────────────────────

adminDashboardApp.get("/api/settings", (c) => {
  return c.json({ settings: listSettings() });
});

adminDashboardApp.put("/api/settings", async (c) => {
  const body = await readJson(c);
  const values =
    body && body.values && typeof body.values === "object" && !Array.isArray(body.values)
      ? (body.values as Record<string, unknown>)
      : null;
  if (!values) {
    return adminJsonError(c, 400, "Field 'values' must be an object");
  }
  try {
    const settings = applySettings(values);
    recordAudit(actor(c), "settings.update", Object.keys(values).join(","), "ok");
    return c.json({ settings });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordAudit(actor(c), "settings.update", Object.keys(values).join(","), "error", {
      message,
    });
    return adminJsonError(c, 400, message);
  }
});

// ─── Model mappings ─────────────────────────────────────────────────────────

function mappingPayload(body: Record<string, unknown>): {
  mappings: Array<{ alias: string; target: string }>;
  fallback: string | null;
} {
  if (typeof body.map === "string") {
    const parsed = parseModelMap(body.map);
    if (parsed.errors.length > 0) {
      throw new Error(parsed.errors.join("; "));
    }
    return { mappings: parsed.mappings, fallback: parsed.fallback };
  }

  const raw = body.mappings;
  if (raw === undefined || raw === null) {
    throw new Error("Field 'map' or 'mappings' is required");
  }

  let mappings: Array<{ alias: string; target: string }>;
  if (Array.isArray(raw)) {
    mappings = raw.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("Each mapping entry must be an object with alias/target");
      }
      const record = entry as Record<string, unknown>;
      return {
        alias: String(record.alias ?? ""),
        target: String(record.target ?? ""),
      };
    });
  } else if (typeof raw === "object") {
    mappings = Object.entries(raw as Record<string, unknown>).map(
      ([alias, target]) => ({ alias, target: String(target ?? "") }),
    );
  } else {
    throw new Error("Field 'mappings' must be an object or an array");
  }

  let fallback: string | null = null;
  if (typeof body.fallback === "string") {
    fallback = body.fallback;
  } else if (body.fallback !== undefined && body.fallback !== null) {
    throw new Error("Field 'fallback' must be a string or null");
  }

  return { mappings, fallback };
}

adminDashboardApp.get("/api/model-mappings", (c) => {
  return c.json(serializeModelMappings(getModelMappingState()));
});

adminDashboardApp.put("/api/model-mappings", async (c) => {
  const body = await readJson(c);
  if (!body) {
    return adminJsonError(c, 400, "A JSON object body is required");
  }
  let target = "unknown";
  try {
    const payload = mappingPayload(body);
    target = payload.mappings.map((entry) => entry.alias).join(",") || "none";
    const validation = validateModelMappings(
      payload.mappings,
      payload.fallback,
    );
    if (!validation.valid) {
      throw new Error(validation.errors.join("; "));
    }
    const state = saveModelMappings(payload);
    recordAudit(
      actor(c),
      "model_mappings.update",
      modelMappingTarget(state),
      "ok",
    );
    return c.json(serializeModelMappings(state));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordAudit(actor(c), "model_mappings.update", target, "error", {
      message,
    });
    return adminJsonError(c, 400, message);
  }
});

adminDashboardApp.delete("/api/model-mappings", (c) => {
  try {
    const state = resetModelMappings();
    recordAudit(actor(c), "model_mappings.reset", "model-mappings.json", "ok");
    return c.json(serializeModelMappings(state));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordAudit(actor(c), "model_mappings.reset", "model-mappings.json", "error", {
      message,
    });
    return adminJsonError(c, 500, message);
  }
});

// ─── Models ─────────────────────────────────────────────────────────────────

adminDashboardApp.get("/api/models", async (c) => {
  try {
    const { models, accountId } = await loadModelsWithVariants();
    return c.json({ accountId, models });
  } catch (error) {
    return adminJsonError(
      c,
      502,
      `Model catalog unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
});

// ─── Logs / audit ───────────────────────────────────────────────────────────

adminDashboardApp.get("/api/logs", (c) => {
  const level = c.req.query("level");
  const limit = Number(c.req.query("limit") ?? "200");
  return c.json({
    logs: redactLogHistory(getServerLogHistory(), level, limit),
  });
});

adminDashboardApp.get("/api/audit", (c) => {
  const limit = Number(c.req.query("limit") ?? "100");
  return c.json({ records: listAudit(limit) });
});

// ─── Live events (SSE) ──────────────────────────────────────────────────────

adminDashboardApp.get("/api/events", (c) => {
  const encoder = new TextEncoder();
  let closed = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (interval) clearInterval(interval);
    unsubscribe?.();
    try {
      controllerRef?.close();
    } catch {}
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          cleanup();
        }
      };

      send("overview", buildOverview());
      interval = setInterval(() => send("overview", buildOverview()), 2_000);
      unsubscribe = subscribeServerLogStream((entry) =>
        send("log", redactLogEntry(entry)),
      );
      c.req.raw.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      cleanup();
    },
  });

  return c.body(stream, 200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
});

// Expose the resolved configuration for diagnostics/tests without secrets.
adminDashboardApp.get("/api/config", (c) => {
  return c.json({
    host: config.server.host,
    port: config.server.port,
    chatMode: listSettings().find((entry) => entry.key === "chat_mode")?.value,
    tls: secureCookie(c),
  });
});
