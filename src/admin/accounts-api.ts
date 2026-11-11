/**
 * Dashboard account operations.
 *
 * Credentials and proxy secrets are never returned: list responses use masked
 * emails and proxy URLs. Every mutation is audited.
 */

import { Hono, type Context } from "hono";
import {
  addAccount,
  loadAccounts,
  removeAccount,
  updateAccountProxy,
} from "../core/accounts.ts";
import { clearAccountCooldown } from "../core/account-manager.ts";
import { refreshHeaders } from "../services/playwright.ts";
import { getUserIdentity } from "../core/request-user.ts";
import { recordAudit } from "../core/admin-audit.ts";
import { buildAccountSnapshots, maskAccountEmail } from "./overview.ts";
import { adminJsonError } from "./auth.ts";

export const accountsApp = new Hono();

function actor(c: Context): string {
  return getUserIdentity(c)?.label || "unknown";
}

function accountExists(id: string): boolean {
  return loadAccounts().some((account) => account.id === id);
}

function snapshotFor(id: string) {
  return buildAccountSnapshots().find((account) => account.id === id);
}

async function readJson(
  c: Context,
): Promise<Record<string, unknown> | null> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

accountsApp.get("/", (c) => {
  return c.json({ accounts: buildAccountSnapshots() });
});

accountsApp.post("/", async (c) => {
  const body = await readJson(c);
  if (!body || typeof body.email !== "string" || !body.email.trim()) {
    return adminJsonError(c, 400, "Field 'email' is required");
  }
  const email = body.email.trim();
  const password =
    typeof body.password === "string" ? body.password : "";
  const proxy =
    typeof body.proxy === "string" && body.proxy.trim()
      ? body.proxy.trim()
      : null;

  try {
    const created = addAccount(email, password, undefined, proxy);
    recordAudit(actor(c), "account.create", maskAccountEmail(email), "ok", {
      id: created.id,
      proxy: Boolean(proxy),
    });
    return c.json({ account: snapshotFor(created.id) }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordAudit(actor(c), "account.create", maskAccountEmail(email), "error", {
      message,
    });
    return adminJsonError(c, 400, message);
  }
});

accountsApp.post("/cooldowns/clear", (c) => {
  const cleared = loadAccounts().filter((account) => {
    if (!account.cooldown_until || account.cooldown_until <= Date.now()) {
      return false;
    }
    clearAccountCooldown(account.id);
    return true;
  }).length;
  recordAudit(actor(c), "account.cooldowns.clear_all", "*", "ok", {
    cleared,
  });
  return c.json({ success: true, cleared });
});

accountsApp.delete("/:id", (c) => {
  const id = c.req.param("id");
  if (!removeAccount(id)) {
    return adminJsonError(c, 404, `Unknown account: ${id}`);
  }
  recordAudit(actor(c), "account.delete", id, "ok");
  return c.json({ success: true });
});

accountsApp.patch("/:id/proxy", async (c) => {
  const id = c.req.param("id");
  const body = await readJson(c);
  if (!body) return adminJsonError(c, 400, "A JSON body is required");
  // `null`/absent clears the proxy. Anything else must be a string: coercing a
  // malformed value to null would silently wipe a working proxy.
  if (
    body.proxy !== undefined &&
    body.proxy !== null &&
    typeof body.proxy !== "string"
  ) {
    return adminJsonError(c, 400, "Field 'proxy' must be a string or null");
  }
  const proxy =
    body.proxy === null || body.proxy === undefined
      ? null
      : (body.proxy as string);

  try {
    if (!updateAccountProxy(id, proxy)) {
      return adminJsonError(c, 404, `Unknown account: ${id}`);
    }
    recordAudit(actor(c), "account.proxy.update", id, "ok", {
      proxy: Boolean(proxy && proxy.trim()),
    });
    return c.json({ account: snapshotFor(id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordAudit(actor(c), "account.proxy.update", id, "error", { message });
    return adminJsonError(c, 400, message);
  }
});

accountsApp.post("/:id/cooldown/clear", (c) => {
  const id = c.req.param("id");
  if (!accountExists(id)) {
    return adminJsonError(c, 404, `Unknown account: ${id}`);
  }
  clearAccountCooldown(id);
  recordAudit(actor(c), "account.cooldown.clear", id, "ok");
  return c.json({ success: true, account: snapshotFor(id) });
});

accountsApp.post("/:id/headers/refresh", async (c) => {
  const id = c.req.param("id");
  if (!accountExists(id)) {
    return adminJsonError(c, 404, `Unknown account: ${id}`);
  }
  try {
    await refreshHeaders(id);
    recordAudit(actor(c), "account.headers.refresh", id, "ok");
    return c.json({ success: true, account: snapshotFor(id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordAudit(actor(c), "account.headers.refresh", id, "error", {
      message,
    });
    return adminJsonError(c, 502, `Header refresh failed: ${message}`);
  }
});
