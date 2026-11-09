/**
 * One-shot SQLite -> Redis migration.
 *
 * Usage:
 *   DATA_SAVE_MODE=redis REDIS_URL=redis://localhost:6379 npm run redis:migrate
 *
 * Existing Redis entities are never overwritten; the command only seeds an
 * empty shared store with the local SQLite snapshot.
 */

import { config } from "../core/config.ts";
import { getDatabase } from "../core/database.ts";
import { migrateLocalSnapshotToRedis } from "../core/redis-store.ts";
import { getLocalSnapshot } from "../core/redis-sync.ts";

async function main(): Promise<void> {
  if (config.persistence.mode !== "redis") {
    console.error(
      "DATA_SAVE_MODE must be 'redis' to migrate (current: " +
        config.persistence.mode +
        ")",
    );
    process.exit(1);
  }
  if (!config.persistence.redis.url) {
    console.error("REDIS_URL is required to migrate local state");
    process.exit(1);
  }

  // Materialize the schema before snapshotting.
  getDatabase();
  const snapshot = getLocalSnapshot();
  console.log(
    `Migrating ${snapshot.accounts.length} account(s), ` +
      `${snapshot.users.length} user(s), ` +
      `${snapshot.sessions.length} session(s), ` +
      `${snapshot.parents.length} parent(s), ` +
      `${snapshot.usage.length} usage row(s), ` +
      `${snapshot.responses.length} response(s) to Redis...`,
  );

  const health = await migrateLocalSnapshotToRedis(snapshot);
  console.log(
    `Migration complete | connected=${health.connected} | degraded=${health.degraded}` +
      (health.lastError ? ` | error=${health.lastError}` : ""),
  );
}

main().catch((error) => {
  console.error(
    "Redis migration failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
