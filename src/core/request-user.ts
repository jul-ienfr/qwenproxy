/**
 * Request-scoped user identity.
 *
 * Hono's Context object is unique per request, so a WeakMap is enough to carry
 * the authenticated identity from the auth middleware to route handlers without
 * threading a typed Env through every sub-app.
 */

import type { Context } from "hono";
import type { UserIdentity } from "./users.ts";

const identities = new WeakMap<Context, UserIdentity>();

export function setUserIdentity(c: Context, identity: UserIdentity): void {
  identities.set(c, identity);
}

export function getUserIdentity(c: Context): UserIdentity | undefined {
  return identities.get(c);
}
