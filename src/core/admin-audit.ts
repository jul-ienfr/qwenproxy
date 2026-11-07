/**
 * Durable audit trail for dashboard mutations.
 *
 * Every write from the web dashboard, admin API or CLI records actor, action,
 * target and result. Audit writes must never break the operation they describe;
 * failures are logged and swallowed.
 */

import { getDatabase } from "./database.ts";

export interface AuditRecord {
  id: number;
  actor: string;
  action: string;
  target: string;
  result: string;
  details: string | null;
  created_at: string;
}

export function recordAudit(
  actor: string,
  action: string,
  target: string,
  result = "ok",
  details?: unknown,
): void {
  try {
    const serialized =
      details === undefined
        ? null
        : typeof details === "string"
          ? details
          : JSON.stringify(details);
    getDatabase()
      .prepare(
        `INSERT INTO admin_audit (actor, action, target, result, details)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        (actor || "unknown").slice(0, 120),
        action.slice(0, 120),
        (target || "").slice(0, 240),
        result.slice(0, 40),
        serialized ? serialized.slice(0, 2000) : null,
      );
  } catch (error) {
    console.warn(
      "⚠️  [Audit] Could not record",
      action,
      "for",
      target,
      ":",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function listAudit(limit = 100): AuditRecord[] {
  const bounded = Math.min(500, Math.max(1, Math.trunc(limit) || 100));
  try {
    return getDatabase()
      .prepare(
        `SELECT id, actor, action, target, result, details, created_at
         FROM admin_audit ORDER BY id DESC LIMIT ?`,
      )
      .all(bounded) as AuditRecord[];
  } catch {
    return [];
  }
}
