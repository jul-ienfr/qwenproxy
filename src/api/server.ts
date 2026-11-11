import net from "node:net";
import { v4 as uuidv4 } from "uuid";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { bodyLimit } from "hono/body-limit";
import { config, getRuntimeChatMode, setRuntimeChatMode } from "../core/config.js";
import { saveTuiSettings } from "../tui/settings.ts";
import { metrics } from "../core/metrics.js";
import { logger, maskEmail } from "../core/logger.js";
import { MemoryCache } from "../cache/memory-cache.js";
import { Watchdog } from "../core/watchdog.js";
import { getAccountCooldownInfo } from "../core/account-manager.js";
import { app as modelsApp } from "./models.js";
import { chatCompletions, chatCompletionsStop } from "../routes/chat.js";
import { uploadFile } from "../routes/upload.js";
import { imagesEdits, imagesGenerations } from "../routes/images.js";
import { videosGenerations, videoTaskStatus } from "../routes/videos.js";
import { app as specializedTasksApp } from "../routes/specialized-tasks.ts";
import { responsesApp } from "../routes/responses/index.js";
import { completionsLegacy } from "../routes/completions.js";
import { anthropicApp } from "../routes/anthropic/index.ts";
import { geminiApp } from "../routes/gemini/index.ts";
import { docsApp } from "./docs.ts";
import { sendOpenAIError, createError } from "./error-helpers.js";
import { AuthError, NotFoundError } from "../core/errors.js";
import type { QwenAccount } from "../core/accounts.js";
import { isAuthMockEnabled } from "../services/auth-playwright.js";
import {
  assertBindAllowed,
  ensureRuntimeApiKey,
  getRuntimeApiKey,
  isLoopbackHost,
} from "../core/local-auth.ts";
import { seedEnvUsers } from "../core/users.ts";
import type { UserIdentity } from "../core/users.ts";
import {
  acquireUserStream,
  checkUserRequest,
  quotaErrorResponse,
  withUserStreamSlot,
} from "../core/user-quota.ts";
import { getUserIdentity, setUserIdentity } from "../core/request-user.ts";
import { adminUsersApp } from "./admin-users.ts";
import {
  extractProvidedApiKeys,
  identityErrorMessage,
  resolveIdentity,
} from "../core/auth-identity.ts";
import { authenticateAdminRequest } from "../admin/auth.ts";
import { adminDashboardApp } from "../admin/app.ts";
import { getBuildMetadata } from "../core/build-info.ts";
import {
  recordOverviewError,
  recordOverviewRequest,
} from "../core/overview-stats.ts";

import {
  hookServerConsoleForLogging,
  getServerLogHistory,
  subscribeServerLogStream,
} from "../core/server-log-buffer.ts";
// Module-level state (initialized in startServer)
let cache: MemoryCache | undefined;
let watchdog: Watchdog | undefined;
let server: any;
let startPromise: Promise<StartedServerInfo> | null = null;
let stopPromise: Promise<void> | null = null;
let signalHandlersInstalled = false;

const app = new Hono();

function formatAccountId(accountId: string): string {
  const normalized = accountId.trim();
  return normalized.length > 12 ? `${normalized.slice(0, 12)}…` : normalized;
}

const MEGABYTE = 1024 * 1024;
/**
 * Request-body budgets. `content-length` is checked without buffering; chunked
 * uploads are buffered only up to the same cap. The upload route accepts Qwen's
 * 100MB video limit, image edits are capped by the route itself at 20MB, and
 * everything else (chat/JSON/admin payloads) stays small.
 */
const DEFAULT_BODY_LIMIT_BYTES = 32 * MEGABYTE;
const UPLOAD_BODY_LIMIT_BYTES = 110 * MEGABYTE;
const IMAGE_EDIT_BODY_LIMIT_BYTES = 22 * MEGABYTE;
const ADMIN_BODY_LIMIT_BYTES = 1 * MEGABYTE;

function bodyLimitForPath(path: string): number {
  if (path === "/v1/upload") return UPLOAD_BODY_LIMIT_BYTES;
  if (path === "/v1/images/edits") return IMAGE_EDIT_BODY_LIMIT_BYTES;
  if (path.startsWith("/admin/api/")) return ADMIN_BODY_LIMIT_BYTES;
  return DEFAULT_BODY_LIMIT_BYTES;
}

/** Protocol-native 413 so oversized bodies do not look like a server crash. */
function payloadTooLarge(c: Context): Response {
  const message = "Request body exceeds the allowed size";
  if (c.req.path.startsWith("/v1beta/")) {
    return c.json(
      {
        error: {
          code: 413,
          message,
          status: "RESOURCE_EXHAUSTED",
        },
      },
      413,
    );
  }
  if (c.req.path.startsWith("/v1/messages")) {
    c.header(
      "anthropic-version",
      c.req.header("anthropic-version") || "2023-06-01",
    );
    return c.json(
      {
        type: "error",
        error: { type: "invalid_request_error", message },
      },
      413,
    );
  }
  if (c.req.path.startsWith("/admin/api/")) {
    return c.json({ error: { type: "invalid_request_error", message } }, 413);
  }
  return c.json(
    {
      error: {
        message,
        type: "invalid_request_error",
        code: "request_too_large",
        param: null,
      },
    },
    413,
  );
}

async function enforceBodyLimit(
  c: Context,
  next: () => Promise<void>,
): Promise<Response | void> {
  return bodyLimit({
    maxSize: bodyLimitForPath(c.req.path),
    onError: payloadTooLarge,
  })(c, next);
}

function buildPortInUseMessage(port: number, host: string): string {
  return (
    `❌ [Server] Port ${port} is already in use (${host}:${port}).` +
    `\n   Another QwenProxy instance (or another program) is listening on this port.` +
    `\n   Stop the other instance first, or start on another port: PORT=3001 npm start`
  );
}

/**
 * Pre-flight port check run BEFORE the slow account warmup so a conflicting
 * listener fails in <1s with an explanatory message instead of crashing the
 * process minutes later after the warmup completes.
 */
async function assertPortAvailable(): Promise<void> {
  const { port, host } = config.server;
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        reject(new Error(buildPortInUseMessage(port, host)));
      } else {
        reject(err);
      }
    });
    probe.once("listening", () => probe.close(() => resolve()));
    probe.listen(port, host);
  });
}

export function setCacheForTesting(nextCache: MemoryCache | undefined): void {
  cache = nextCache;
}

// Middleware must be registered BEFORE routes

// Explicit CORS configuration wins. Without it, browser clients running on a
// loopback origin are allowed while arbitrary pages cannot drive the local API.
function getCorsOrigin(requestOrigin?: string): string {
  const configured = (process.env.CORS_ORIGIN || "").trim();
  if (configured) return configured;
  if (!requestOrigin) return "";

  try {
    const origin = new URL(requestOrigin);
    if (
      (origin.protocol === "http:" || origin.protocol === "https:") &&
      isLoopbackHost(origin.hostname)
    ) {
      return requestOrigin;
    }
  } catch {
    return "";
  }
  return "";
}

app.use("*", async (c, next) => {
  const corsOrigin = getCorsOrigin(c.req.header("Origin"));
  if (corsOrigin) {
    c.header("Access-Control-Allow-Origin", corsOrigin);
    c.header("Vary", "Origin");
    c.header(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    c.header(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, X-Request-Id, x-api-key, x-goog-api-key, OpenAI-Organization, OpenAI-Project, X-Client-Request-Id, X-QwenProxy-Chat-Mode",
    );
    c.header(
      "Access-Control-Expose-Headers",
      "X-Request-Id, X-Response-Time, openai-version, openai-processing-ms, x-ratelimit-limit-requests, x-ratelimit-remaining-requests, x-ratelimit-reset-requests, x-ratelimit-limit-tokens, x-ratelimit-remaining-tokens, x-ratelimit-reset-tokens",
    );
  }
  if (c.req.method === "OPTIONS") {
    if (!corsOrigin) {
      return new Response(null, { status: 204 });
    }
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": corsOrigin,
        Vary: "Origin",
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Authorization, Content-Type, X-Request-Id, x-api-key, x-goog-api-key, OpenAI-Organization, OpenAI-Project, X-Client-Request-Id, X-QwenProxy-Chat-Mode",
        "Access-Control-Expose-Headers":
          "X-Request-Id, X-Response-Time, openai-version, openai-processing-ms, x-ratelimit-limit-requests, x-ratelimit-remaining-requests, x-ratelimit-reset-requests, x-ratelimit-limit-tokens, x-ratelimit-remaining-tokens, x-ratelimit-reset-tokens",
      },
    });
  }
  await next();
});

app.use("*", async (c, next) => {
  const requestId = c.req.header("X-Request-Id") || uuidv4();
  c.header("X-Request-Id", requestId);

  // OpenAI-shaped response headers (doc §5.2): API version, processing time,
  // and static rate-limit windows so tools that parse x-ratelimit-* don't choke.
  c.header("openai-version", "2020-10-01");
  const ratelimit = config.server.rateLimit;
  c.header("x-ratelimit-limit-requests", String(ratelimit.requests));
  c.header(
    "x-ratelimit-remaining-requests",
    String(Math.max(0, ratelimit.requests - 1)),
  );
  c.header("x-ratelimit-reset-requests", "0");
  c.header("x-ratelimit-limit-tokens", String(ratelimit.tokens));
  c.header(
    "x-ratelimit-remaining-tokens",
    String(Math.max(0, ratelimit.tokens - 1)),
  );
  c.header("x-ratelimit-reset-tokens", "0");
  const isProbe =
    c.req.path === "/health" ||
    c.req.path === "/metrics" ||
    c.req.path === "/logs" ||
    c.req.path.startsWith("/logs") ||
    c.req.path.startsWith("/diagnostics") ||
    c.req.path === "/favicon.ico" ||
    c.req.path === "/v1/models" ||
    c.req.path.startsWith("/v1/models/") ||
    c.req.path === "/v1beta/models" ||
    c.req.path.startsWith("/v1beta/models/") ||
    c.req.path === "/models" ||
    c.req.path.startsWith("/models/") ||
    c.req.path === "/v1/chat/mode" ||
    c.req.path === "/chat/mode" ||
    c.req.path === "/openapi.json" ||
    c.req.path === "/docs";

  if (!isProbe) {
    metrics.increment("requests.total");
    recordOverviewRequest();
  }
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  if (!isProbe) {
    metrics.histogram("latency.request", duration);
  }
  if (c.res.status >= 500) {
    recordOverviewError();
  }
  c.header("X-Response-Time", `${duration}ms`);
  c.header("openai-processing-ms", String(duration));
});

type AuthResult =
  | { identity: UserIdentity; error?: undefined }
  | { identity?: undefined; error: Response };

function authErrorResponse(c: Context, message: string): Response {
  const isGemini = c.req.path.startsWith("/v1beta/");
  if (isGemini) {
    return c.json(
      {
        error: {
          code: 401,
          message,
          status: "UNAUTHENTICATED",
        },
      },
      401,
    );
  }

  const isAnthropic =
    c.req.path.startsWith("/v1/messages") ||
    Boolean(c.req.header("anthropic-version"));

  if (isAnthropic) {
    c.header("anthropic-version", c.req.header("anthropic-version") || "2023-06-01");
    return c.json(
      {
        type: "error",
        error: {
          type: "authentication_error",
          message,
        },
      },
      401,
    );
  }
  return sendOpenAIError(c, new AuthError(message));
}

/**
 * Resolve the request identity from the legacy global API_KEY, a per-user
 * SQLite key, or the historical loopback no-auth behavior. Quota enforcement
 * happens after authentication, in the /v1 middleware.
 */
function authenticateRequest(c: Context): AuthResult {
  const candidates = extractProvidedApiKeys({
    authorization: c.req.header("Authorization"),
    apiKey: c.req.header("x-api-key"),
    googApiKey: c.req.header("x-goog-api-key"),
    // Gemini SDKs may put the key in the query string. Scope this to
    // /v1beta/* so the key never lands in logs for other routes more than it
    // already would through explicit headers.
    queryKey: c.req.path.startsWith("/v1beta/")
      ? c.req.query("key")
      : undefined,
  });
  const resolution = resolveIdentity(candidates);
  if (resolution.error || !resolution.identity) {
    return {
      error: authErrorResponse(
        c,
        identityErrorMessage(resolution.error ?? "invalid"),
      ),
    };
  }
  return { identity: resolution.identity };
}

/**
 * Operational endpoints expose process-wide state (logs, metrics, upstream
 * account diagnostics) and must not be readable with a regular tenant key.
 * The legacy global API_KEY and the local no-auth operator are admins, so
 * existing single-operator deployments keep working unchanged.
 */
function requireAdminAccess(c: Context): Response | null {
  const auth = authenticateRequest(c);
  if (auth.error) return auth.error;
  if (auth.identity.role !== "admin") {
    return sendOpenAIError(c, createError(403, "Admin role required"));
  }
  return null;
}

/**
 * Protocol adapters re-enter `/v1/chat/completions` over loopback with the
 * operator credential, so the inner request cannot enforce the caller's
 * concurrent-stream cap. Apply it to the adapter surface itself; the chat route
 * already does this for direct `/v1/chat/completions` calls.
 */
function needsAdapterStreamSlot(c: Context): boolean {
  if (c.req.method !== "POST") return false;
  const path = c.req.path;
  if (path === "/v1/messages/count_tokens") return false;
  return (
    path === "/v1/messages" ||
    path === "/v1/responses" ||
    path === "/v1/completions" ||
    path.startsWith("/v1beta/models/")
  );
}

/**
 * Streaming is selected by the URL for Gemini and by `stream:true` in the body
 * for the OpenAI-shaped adapters. Only streamed responses hold a slot, matching
 * the direct chat route's semantics. The body is read from a clone so the route
 * can still parse the original request.
 */
async function adapterWillStream(c: Context): Promise<boolean> {
  if (c.req.path.startsWith("/v1beta/models/")) {
    return c.req.path.endsWith(":streamGenerateContent");
  }
  try {
    const body = (await c.req.raw.clone().json()) as { stream?: unknown };
    return body?.stream === true;
  } catch {
    return false;
  }
}

async function adapterStreamGuard(c: Context, next: () => Promise<void>) {
  if (!needsAdapterStreamSlot(c)) return next();
  if (!(await adapterWillStream(c))) return next();

  const release = acquireUserStream(getUserIdentity(c));
  if (!release) {
    return quotaErrorResponse(c, 1, "concurrency");
  }

  try {
    await next();
  } catch (error) {
    release();
    throw error;
  }

  const contentType = c.res.headers.get("content-type") || "";
  if (c.res.body && contentType.includes("text/event-stream")) {
    c.res = withUserStreamSlot(c.res, release);
  } else {
    release();
  }
}

app.use("/v1/*", async (c, next) => {
  const auth = authenticateRequest(c);
  if (auth.error) return auth.error;
  setUserIdentity(c, auth.identity);

  const decision = checkUserRequest(auth.identity);
  if (!decision.allowed) {
    return quotaErrorResponse(
      c,
      decision.retryAfterSec ?? 1,
      decision.reason ?? "rpm",
    );
  }

  await next();
});

app.use("/v1/*", enforceBodyLimit);
app.use("/v1/*", adapterStreamGuard);

// Gemini-compatible surface. It shares identity resolution with /v1 but uses
// the Gemini error envelope (via authErrorResponse / quotaErrorResponse).
app.use("/v1beta/*", async (c, next) => {
  const auth = authenticateRequest(c);
  if (auth.error) return auth.error;
  setUserIdentity(c, auth.identity);

  const decision = checkUserRequest(auth.identity);
  if (!decision.allowed) {
    return quotaErrorResponse(
      c,
      decision.retryAfterSec ?? 1,
      decision.reason ?? "rpm",
    );
  }

  await next();
});

app.use("/v1beta/*", enforceBodyLimit);
app.use("/v1beta/*", adapterStreamGuard);

app.use("/admin/api/*", async (c, next) => {
  if (c.req.path === "/admin/api/session") return next();

  const auth = authenticateAdminRequest(c);
  if ("response" in auth) return auth.response;
  if (auth.identity.role !== "admin") {
    return c.json(
      { error: { type: "permission_error", message: "Admin role required" } },
      403,
    );
  }
  setUserIdentity(c, auth.identity);
  await next();
});

app.use("/admin/api/*", enforceBodyLimit);

// Routes
app.route("", modelsApp);
app.route("/admin", adminDashboardApp);
app.route("/admin", adminUsersApp);
app.post("/v1/chat/completions", chatCompletions);
app.post("/v1/chat/completions/stop", chatCompletionsStop);
app.post("/v1/completions", completionsLegacy);
app.post("/v1/upload", uploadFile);
app.post("/v1/images/generations", imagesGenerations);
app.post("/v1/images/edits", imagesEdits);
app.post("/v1/videos/generations", videosGenerations);
app.get("/v1/tasks/status/:taskId", videoTaskStatus);
app.route("", specializedTasksApp);
app.get("/v1/chat/mode", (c) => {
  return c.json({ mode: getRuntimeChatMode() });
});
app.post("/v1/chat/mode", async (c) => {
  const identity = getUserIdentity(c);
  if (!identity) {
    return sendOpenAIError(c, createError(401, "Missing or invalid credentials"));
  }
  if (identity.role !== "admin") {
    return sendOpenAIError(c, createError(403, "Admin role required"));
  }
  const parsed = await c.req.json().catch(() => ({}));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return c.json(
      { error: { message: "Request body must be a JSON object" } },
      400,
    );
  }
  const body = parsed as { mode?: unknown };
  if (typeof body.mode !== "string" || body.mode.trim() === "") {
    return c.json({ error: { message: "Field 'mode' is required" } }, 400);
  }
  const updated = setRuntimeChatMode(body.mode);
  saveTuiSettings({ chat: { mode: updated } });
  return c.json({ success: true, mode: updated });
});
// OpenAI Responses API compatible routes
app.route("", responsesApp);
app.route("", anthropicApp);
// Gemini Generative Language API compatible routes
app.route("", geminiApp);
// Public OpenAPI contract and interactive documentation
app.route("", docsApp);

// Accept paths without the /v1 prefix via a 308 redirect (method + body are
// preserved on redirect). Most clients append /v1 themselves; the redirect
// covers the rest without duplicating handlers.
const LEGACY_REDIRECTS: Array<[string, string]> = [
  ["/chat/completions", "/v1/chat/completions"],
  ["/completions", "/v1/completions"],
  ["/responses", "/v1/responses"],
  ["/models", "/v1/models"],
  ["/messages", "/v1/messages"],
  ["/messages/count_tokens", "/v1/messages/count_tokens"],
];
for (const [from, to] of LEGACY_REDIRECTS) {
  app.all(from, (c) => c.redirect(to, 308));
}

app.get("/health", async (c) => {
  const status = await watchdog?.getStatus();
  const persistence = (await import("../core/redis-store.ts")).getRedisHealth();
  const publicBody = {
    status: persistence.degraded ? "degraded" : status?.overall || "unknown",
    timestamp: Date.now(),
    persistence: {
      mode: persistence.mode,
      connected: persistence.connected,
      degraded: persistence.degraded,
    },
  };
  const apiKeyConfigured = Boolean(getRuntimeApiKey() || config.apiKey);
  const auth = authenticateRequest(c);
  // Detailed build/runtime/usage data is operator-only; unauthenticated or
  // regular-user callers still get the public liveness snapshot above.
  if (!apiKeyConfigured || auth.error || auth.identity.role !== "admin") {
    return c.json(publicBody);
  }

  const build = getBuildMetadata();
  return c.json({
    ...publicBody,
    version: build.version,
    commit: build.commit,
    buildDate: build.buildDate,
    runtime: build.runtime,
    ram: status?.ram || "unknown",
    streams: status?.streams || "unknown",
    heap: status?.heap
      ? {
          used: status.heap.heapUsed,
          total: status.heap.heapTotal,
          limit: status.heap.heapSizeLimit,
          rss: status.heap.rss,
          usagePercent: Number(status.heap.usagePercent.toFixed(2)),
        }
      : undefined,
    readyAccounts: (await import("../core/account-manager.js")).getHeadersReadyAccountIds(),
    activeAccounts: (await import("../services/playwright.js")).getActivePlaywrightAccountIds(),
    metrics: {
      cache: await cache?.getStats(),
      requestsTotal: Number(metrics.get("requests.total")?.value ?? 0),
      requestsErrors: Number(metrics.get("requests.errors")?.value ?? 0),
      latencyAvgMs: (() => {
        const hist = metrics.get("latency.request")?.value;
        if (hist && typeof hist === "object" && (hist as any).count > 0) {
          return Math.round((hist as any).sum / (hist as any).count);
        }
        return 0;
      })(),
      deltasCount: Number(metrics.get("requests.delta")?.value ?? 0),
      fullReplaysCount: Number(metrics.get("requests.full")?.value ?? 0),
      toolCallsCount: Number(metrics.get("toolcalls.total")?.value ?? 0),
      toolCallsRecovered: Number(metrics.get("toolcalls.recovered")?.value ?? 0),
      captchasDetected: Number(metrics.get("captcha.challenges.detected")?.value ?? 0),
      captchasSolved: Number(metrics.get("captcha.solves.succeeded")?.value ?? 0),
      chatsCleaned: Number(metrics.get("chats.cleaned")?.value ?? 0),
    },
    dailyUsage: (await import("../core/daily-usage.ts")).getPoolDailyUsageSummary(),
    persistence: (await import("../core/redis-store.ts")).getRedisHealth(),
  });
});

// Token TTL diagnostics: inspect real cookie/header lifetimes
app.get("/diagnostics/tokens", async (c) => {
  const denied = requireAdminAccess(c);
  if (denied) return denied;

  const { getTokenDiagnostics } = await import("../services/playwright.ts");
  const accountId = c.req.query("accountId");

  try {
    const diagnostics = await getTokenDiagnostics(accountId);
    return c.json(diagnostics);
  } catch (err) {
    return c.json(
      {
        error: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

app.get("/metrics", (c) => {
  const denied = requireAdminAccess(c);
  if (denied) return denied;
  return c.text(metrics.formatPrometheus(), {
    headers: { "Content-Type": "text/plain; version=0.0.4" },
  });
});

app.get("/logs", (c) => {
  const denied = requireAdminAccess(c);
  if (denied) return denied;
  return c.json(getServerLogHistory());
});

app.get("/logs/live", (c) => {
  const denied = requireAdminAccess(c);
  if (denied) return denied;
  const encoder = new TextEncoder();
  return c.body(
    new ReadableStream({
      start(controller) {
        const past = getServerLogHistory();
        for (const entry of past) {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`));
          } catch {}
        }

        const unsubscribe = subscribeServerLogStream((entry) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`));
          } catch {
            unsubscribe();
          }
        });

        c.req.raw.signal.addEventListener("abort", () => {
          unsubscribe();
        });
      },
    }),
    200,
    {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  );
});

app.onError((err, c) => {
  const requestId = c.req.header("X-Request-Id") || "unknown";
  const isProbe =
    c.req.path === "/health" ||
    c.req.path === "/metrics" ||
    c.req.path.startsWith("/diagnostics") ||
    c.req.path === "/favicon.ico" ||
    c.req.path === "/v1/models" ||
    c.req.path.startsWith("/v1/models/") ||
    c.req.path === "/v1beta/models" ||
    c.req.path.startsWith("/v1beta/models/") ||
    c.req.path === "/models" ||
    c.req.path.startsWith("/models/") ||
    c.req.path === "/v1/chat/mode" ||
    c.req.path === "/chat/mode";
  if (!isProbe) {
    metrics.increment("requests.errors");
  }
  logger.error("API Error", {
    requestId,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return sendOpenAIError(c, err);
});

app.notFound((c) => sendOpenAIError(c, new NotFoundError("Not found")));

export interface StartedServerInfo {
  host: string;
  port: number;
  url: string;
}

function buildStartedServerInfo(): StartedServerInfo {
  const host =
    config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host;
  return {
    host,
    port: config.server.port,
    url: `http://${host}:${config.server.port}`,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function warmConfiguredChatPools(
  warmQwenChatPool: (
    accountId: string | undefined,
    modelId: string,
  ) => Promise<void>,
  accountId?: string,
): Promise<void> {
  if (config.qwen.chatPoolSize <= 0) return;
  await Promise.all(
    config.qwen.chatPoolModels.map((model) =>
      warmQwenChatPool(accountId, model).catch(() => {}),
    ),
  );
}

async function prepareQwenRuntime(params: {
  accountId?: string;
  successMessage: string;
  failureMessage: string;
  initAuth: () => Promise<void>;
  disableNativeTools: (accountId?: string) => Promise<void>;
  warmQwenChatPool: (
    accountId: string | undefined,
    modelId: string,
  ) => Promise<void>;
}): Promise<boolean> {
  if (params.accountId) {
    const { getAccountCooldownInfo } =
      await import("../core/account-manager.ts");
    const cooldownInfo = getAccountCooldownInfo(params.accountId);
    if (cooldownInfo) {
      console.warn(
        `⚠️ [Server] Account not ready | account=${formatAccountId(params.accountId)} | cooldown=${Math.ceil(cooldownInfo.remainingMs / 1000)}s | reason=${cooldownInfo.reason}`,
      );
      return false;
    }
  }

  try {
    await params.initAuth();
    await params.disableNativeTools(params.accountId).catch(() => {});
    await warmConfiguredChatPools(params.warmQwenChatPool, params.accountId);
    if (params.accountId) {
      const { getAccountCooldownInfo } =
        await import("../core/account-manager.ts");
      const cooldownInfo = getAccountCooldownInfo(params.accountId);
      if (cooldownInfo) {
        console.warn(
          `⚠️ [Server] Account not ready | account=${formatAccountId(params.accountId)} | cooldown=${Math.ceil(cooldownInfo.remainingMs / 1000)}s | reason=${cooldownInfo.reason}`,
        );
        return false;
      }
    }
    return true;
  } catch (error) {
    console.warn(`❌ ${params.failureMessage}`, getErrorMessage(error));
    if (params.accountId) {
      const { markAccountRateLimited } =
        await import("../core/account-manager.ts");
      const message = getErrorMessage(error);
      const reason = message.includes("ProxyUnavailable")
        ? "ProxyUnavailable"
        : "AuthInitFailed";
      markAccountRateLimited(
        params.accountId,
        config.concurrency.initFailureCooldownMs,
        reason,
      );
    }
    return false;
  }
}

async function prepareAccountRuntime(
  account: QwenAccount,
  getAccountCredentials: (accountId: string) => QwenAccount | undefined,
  initPlaywrightForAccount: (
    account: QwenAccount,
    headless: boolean,
    browserType?: "chromium" | "chrome" | "edge",
  ) => Promise<void>,
  disableNativeTools: (accountId?: string) => Promise<void>,
  warmQwenChatPool: (
    accountId: string | undefined,
    modelId: string,
  ) => Promise<void>,
): Promise<boolean> {
  return prepareQwenRuntime({
    accountId: account.id,
    successMessage: `[Server] Account ready: ${maskEmail(account.email)}`,
    failureMessage: `[Server] Account init failed ${maskEmail(account.email)}:`,
    initAuth: () => {
      const credentials = getAccountCredentials(account.id);
      if (!credentials) {
        throw new Error(`Account ${account.id} credentials not found`);
      }
      return initPlaywrightForAccount(
        credentials,
        config.playwright.headless,
        config.playwright.browser,
      );
    },
    disableNativeTools,
    warmQwenChatPool,
  });
}

async function prepareRemainingAccountsInBackground(params: {
  accounts: QwenAccount[];
  batchSize: number;
  totalAccounts: number;
  getAccountCredentials: (accountId: string) => QwenAccount | undefined;
  initPlaywrightForAccount: (
    account: QwenAccount,
    headless: boolean,
    browserType?: "chromium" | "chrome" | "edge",
  ) => Promise<void>;
  disableNativeTools: (accountId?: string) => Promise<void>;
  warmQwenChatPool: (
    accountId: string | undefined,
    modelId: string,
  ) => Promise<void>;
}): Promise<void> {
  const remaining = params.accounts;
  if (remaining.length === 0) return;

  // First account was already prepared successfully (displayed as 1/N),
  // so remaining accounts start at display index 2.
  let nextDisplayIndex = 2;
  for (let i = 0; i < remaining.length; i += params.batchSize) {
    const batch = remaining.slice(i, i + params.batchSize);
    const batchDisplayStart = nextDisplayIndex;
    nextDisplayIndex += batch.length;

    await Promise.all(
      batch.map((account, batchIndex) =>
        prepareAccountRuntime(
          account,
          params.getAccountCredentials,
          params.initPlaywrightForAccount,
          params.disableNativeTools,
          params.warmQwenChatPool,
        ).then((ok) => {
          if (ok) {
            const displayIndex = batchDisplayStart + batchIndex;
            console.log(
              `✅ [Server] Account ready (${displayIndex}/${params.totalAccounts}): ${maskEmail(account.email)}`,
            );
          }
          return ok;
        }),
      ),
    );
  }
}

async function cleanupServerResources(): Promise<void> {
  watchdog?.stop();
  watchdog = undefined;
  metrics.stopCollection();

  try {
    await cache?.close();
  } finally {
    cache = undefined;
  }

  try {
    const { stopSessionKeeper } = await import("../services/session-keeper.ts");
    stopSessionKeeper();
  } catch {
    // Session keeper may not have been initialized.
  }

  if (config.qwen.deleteAllChatsOnShutdown) {
    try {
      const { deleteChatsForConfiguredAccounts } =
        await import("../services/chat-cleanup.ts");
      const result = await deleteChatsForConfiguredAccounts();
      console.log(
        `🗑️  [Server] Deleted Qwen chats on shutdown: ${result.succeeded}/${result.attempted} scope(s)`,
      );
    } catch (error) {
      console.error(
        `❌ [Server] Failed to delete Qwen chats on shutdown:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const { closeAllPlaywright } = await import("../services/playwright.ts");
  await closeAllPlaywright();

  const activeServer = server;
  server = undefined;
  if (activeServer?.close) {
    // Drain in-flight requests BEFORE flushing: a request finishing during the
    // drain can still call updateLogicalThreadState, and its debounced write
    // must land in SQLite while the DB is still open.
    await new Promise<void>((resolve) => {
      try {
        if (activeServer.close.length > 0) {
          activeServer.close(() => resolve());
        } else {
          activeServer.close();
          resolve();
        }
      } catch {
        resolve();
      }
    });
  }

  const { flushLogicalThreadState } = await import("../services/qwen.ts");
  try {
    // Debounced logical-thread upserts must land before the DB closes.
    flushLogicalThreadState();
  } catch {
    // Persistence is best-effort; the in-memory cache already served this run.
  }

  if (config.persistence.mode === "redis") {
    try {
      const { shutdownRedisPersistence } = await import("../core/redis-store.ts");
      await shutdownRedisPersistence();
    } catch {
      // Redis shutdown is best-effort; the process still exits cleanly.
    }
  }

  const { closeDatabase } = await import("../core/database.ts");
  closeDatabase();
}

async function handleSignal(signal: string): Promise<never> {
  console.log(
    `🛑 [Server] Shutdown | ${signal}`,
  );
  await stopServer();
  process.exit(0);
}

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  process.on("SIGINT", () => {
    void handleSignal("SIGINT");
  });
  process.on("SIGTERM", () => {
    void handleSignal("SIGTERM");
  });
  signalHandlersInstalled = true;
}

export async function stopServer(): Promise<void> {
  if (stopPromise) {
    await stopPromise;
    return;
  }

  stopPromise = (async () => {
    if (!server && !cache && !watchdog) return;
    await cleanupServerResources();
  })();

  try {
    await stopPromise;
  } finally {
    stopPromise = null;
  }
}

export async function startServer(options?: {
  installSignalHandlers?: boolean;
  showBanner?: boolean;
}): Promise<StartedServerInfo> {
  hookServerConsoleForLogging();
  if (server) {
    if (options?.installSignalHandlers !== false) installSignalHandlers();
    return buildStartedServerInfo();
  }

  if (startPromise) {
    return startPromise;
  }

  startPromise = (async () => {
    const { getAppVersion } = await import("../core/version.ts");
    const appVersion = getAppVersion();
    if (options?.showBanner !== false && !isAuthMockEnabled()) {
      console.log(`🚀 [Server] Iniciando QwenProxy ${appVersion} na porta ${config.server.port}...`);
    }

    cache = new MemoryCache();
    await cache.connect();

    ensureRuntimeApiKey(config.server.host);
    assertBindAllowed(config.server.host, getRuntimeApiKey() || config.apiKey);

    // Optional shared persistence must hydrate SQLite BEFORE accounts/users are
    // loaded, otherwise a freshly started instance would briefly serve an empty
    // or stale snapshot. In SQLite mode this is a no-op.
    if (config.persistence.mode === "redis") {
      const { initRedisPersistence } = await import("../core/redis-store.ts");
      const { createRedisHandlers, getLocalSnapshot } = await import(
        "../core/redis-sync.ts"
      );
      await initRedisPersistence({
        handlers: createRedisHandlers(),
        snapshot: getLocalSnapshot,
      });
    }

    const { loadAccounts, getAccountCredentials } =
      await import("../core/accounts.ts");
    const accounts = loadAccounts();

    // Materialize USER_API_KEYS bootstrap entries before accepting traffic.
    seedEnvUsers();

    // Recover specialized async tasks left running by a previous process and
    // prune expired rows before the HTTP surface accepts requests.
    const { initializeSpecializedTasks } = await import(
      "../core/specialized-tasks.ts"
    );
    initializeSpecializedTasks();

    if (accounts.length === 0 && !isAuthMockEnabled()) {
      throw new Error(
        "❌ [Server] No Qwen accounts configured. Configure an account with `npm run login`, the QWEN_ACCOUNTS environment variable, or the accounts database before starting the server.",
      );
    }

    // Fail fast on a taken port (the most common startup crash) BEFORE the
    // slow account warmup — the previous behavior bound only after warmup and
    // then crashed with a raw Node stack trace minutes into startup.
    await assertPortAvailable();

    // Restore persisted cooldowns (e.g. daily quota windows) from the database
    // instead of wiping them on restart — retrying a still-rate-limited account
    // wastes a request and immediately re-trips the same limit. Expired
    // entries are dropped lazily by the cooldown lookup.
    const { syncCooldownsFromDb } =
      await import("../core/account-manager.ts");
    syncCooldownsFromDb(accounts);

    const { getAccountsByPriority } =
      await import("../core/account-priority.ts");

    const { disableNativeTools, warmQwenChatPool } =
      await import("../services/qwen.ts");
    const { initPlaywrightForAccount, isPlaywrightInitialized } =
      await import("../services/playwright.ts");

    const BATCH_SIZE = config.playwright.initBatchSize;

    if (accounts.length > 0) {
      const totalAccounts = accounts.length;

      // Warm accounts in priority order, giving top precedence to accounts
      // that already have valid, non-expired sessions in SQLite (restores in ~0.5s),
      // skipping accounts still on cooldown. Warm the primary account first so
      // the server binds the port and goes online immediately (~5-10s).
      // Reserve account(s) and standby validations run seamlessly in background.
      const { getValidAuthSession } = await import("../core/database.ts");
      const warmOrder = getAccountsByPriority(accounts)
        .filter((account) => !getAccountCooldownInfo(account.id))
        .sort((a, b) => {
          const aHasSession = getValidAuthSession(a.id) !== null ? 1 : 0;
          const bHasSession = getValidAuthSession(b.id) !== null ? 1 : 0;
          return bHasSession - aHasSession;
        });
      const readyAccountIds = new Set<string>();

      for (let i = 0; i < warmOrder.length; i++) {
        const ok = await prepareAccountRuntime(
          warmOrder[i],
          getAccountCredentials,
          initPlaywrightForAccount,
          disableNativeTools,
          warmQwenChatPool,
        );
        if (ok) {
          readyAccountIds.add(warmOrder[i].id);
          console.log(
            `✅ [Server] Account ready (1/${totalAccounts}): ${maskEmail(warmOrder[i].email)}`,
          );
          break;
        }
      }

      const remainingAccounts = accounts
        .filter((account) => !readyAccountIds.has(account.id))
        .sort((a, b) => {
          const aHasSession = getValidAuthSession(a.id) !== null ? 1 : 0;
          const bHasSession = getValidAuthSession(b.id) !== null ? 1 : 0;
          return bHasSession - aHasSession;
        });
      if (readyAccountIds.size === 0) {
        console.warn(
          `⚠️  [Server] No account ready during startup; continuing in background`,
        );
      }

      if (config.playwright.prepareAllOnStartup || readyAccountIds.size === 0) {
        if (config.playwright.prepareAllOnStartup && remainingAccounts.length > 0) {
          console.log(
            `🪶 [Server] Preparing ${remainingAccounts.length} standby account(s) in background`,
          );
        }
        void prepareRemainingAccountsInBackground({
          accounts: remainingAccounts,
          batchSize: BATCH_SIZE,
          totalAccounts,
          getAccountCredentials,
          initPlaywrightForAccount,
          disableNativeTools,
          warmQwenChatPool,
        }).catch((error) => {
          console.warn(
            `❌ [Server] Background account preparation failed: ${getErrorMessage(error)}`,
          );
        });
      } else if (remainingAccounts.length > 0) {
        // In background: warm reserve accounts up to a safe limit (default 4 total ready accounts)
        // to prevent IP-level login flood / anti-bot challenge rate-limits on Alibaba.
        void (async () => {
          const { ensureAccountInPriority } = await import("../core/account-priority.ts");

          const maxWarmCap =
            config.playwright.maxActiveContexts > 0
              ? Math.min(
                  config.playwright.startupWarmAccounts,
                  config.playwright.maxActiveContexts,
                )
              : config.playwright.startupWarmAccounts;
          const targetWarmTotal = Math.min(maxWarmCap, totalAccounts);
          let currentReadyCount = readyAccountIds.size;

          if (currentReadyCount < targetWarmTotal && remainingAccounts.length > 0) {
            for (const reserveAccount of remainingAccounts) {
              if (currentReadyCount >= targetWarmTotal) break;
              try {
                const ok = await prepareAccountRuntime(
                  reserveAccount,
                  getAccountCredentials,
                  initPlaywrightForAccount,
                  disableNativeTools,
                  warmQwenChatPool,
                );
                if (ok) {
                  readyAccountIds.add(reserveAccount.id);
                  ensureAccountInPriority(reserveAccount.id);
                  currentReadyCount++;
                  console.log(
                    `✅ [Server] Reserve account ready (${currentReadyCount}/${totalAccounts}): ${maskEmail(reserveAccount.email)}`,
                  );
                }
              } catch (err) {
                console.warn(
                  `⚠️  [Server] Failed to warm reserve account ${maskEmail(reserveAccount.email)}: ${getErrorMessage(err)}`,
                );
              }
            }
          }

          const standbyCount = totalAccounts - currentReadyCount;
          if (standbyCount > 0) {
            console.log(
              `🪶 [Server] ${standbyCount} standby account(s) ready in pool (will initialize on demand when active accounts rotate)`,
            );
          }
        })().catch((error) => {
          console.warn(
            `❌ [Server] Background account preparation failed: ${getErrorMessage(error)}`,
          );
        });
      }
    }

    watchdog = new Watchdog();
    watchdog.start();

    metrics.startCollection();

    const { startSessionKeeper } =
      await import("../services/session-keeper.ts");
    startSessionKeeper();

    const { startLeaseSweepTimer } =
      await import("../core/account-concurrency.ts");
    startLeaseSweepTimer();

    const { scheduleStartupChatCleanup } =
      await import("../services/chat-cleanup.ts");
    scheduleStartupChatCleanup();
    const serverInstance = serve({
      fetch: app.fetch,
      port: config.server.port,
      hostname: config.server.host,
    });
    // Node's http.Server emits 'error' (EADDRINUSE and friends) asynchronously,
    // AFTER serve() returns — with no listener the process crashes with a raw
    // stack trace. The pre-flight check above catches the common case before
    // warmup; this listener is the safety net for the rare race where the port
    // is taken between the check and the bind.
    serverInstance.on("error", (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        console.error(
          buildPortInUseMessage(config.server.port, config.server.host),
        );
      } else {
        console.error(`❌ [Server] Listen failed: ${err.message}`);
      }
      process.exit(1);
    });
    server = serverInstance;

    if (options?.installSignalHandlers !== false) {
      installSignalHandlers();
    }

    const started = buildStartedServerInfo();
    const accountCount = accounts.length;
    const warmCount = accounts.filter((account) =>
      isPlaywrightInitialized(account.id),
    ).length;

    // API key display: just show if it's set or not
    const apiKey = process.env.API_KEY || config.apiKey;
    const apiKeyDisplay = apiKey ? "Set" : "Not set";

    // Use only fixed-width chars (ASCII + ●) to guarantee perfect alignment
    // across all terminals (emojis vary between 1-2 cell widths unpredictably)
    const W = 58; // inner width (60 minus 2 border chars)
    const center = (text: string): string => {
      const padLeft = Math.floor((W - text.length) / 2);
      const padRight = W - text.length - padLeft;
      return " ".repeat(padLeft) + text + " ".repeat(padRight);
    };
    const blank = () => " ".repeat(W);
    const row = (label: string, value: string): string => {
      const labelCol = (label + " ".repeat(Math.max(0, 12 - label.length)));
      const valCol = value + " ".repeat(Math.max(0, W - 14 - value.length));
      return "  " + labelCol + valCol;
    };

    const endpoint = `${started.url}/v1`;

    if (options?.showBanner !== false && !isAuthMockEnabled()) {
      console.log(`
+${"-".repeat(W)}+
|${blank()}|
|${center(`QwenProxy ${appVersion}`)}|
|${center("OpenAI & Anthropic Compatible API")}|
|${blank()}|
+${"-".repeat(W)}+
|${blank()}|
|${row("Endpoint", endpoint)}|
|${row("Port", String(started.port))}|
|${row("Accounts", `${warmCount}/${accountCount} warm`)}|
|${row("API Key", apiKeyDisplay)}|
|${row("Status", "● Online")}|
|${blank()}|
+${"-".repeat(W)}+
`);
    }
    return started;
  })();

  try {
    return await startPromise;
  } catch (error) {
    await cleanupServerResources().catch(() => {});
    throw error;
  } finally {
    startPromise = null;
  }
}

export { app };
