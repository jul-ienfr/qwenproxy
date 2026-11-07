/**
 * Multi-user API key management CLI.
 *
 * Usage:
 *   npm run users list
 *   npm run users create <label> [--rpm N] [--concurrency N] [--admin]
 *   npm run users revoke <id|label>
 *   npm run users rotate <id|label>
 *   npm run users limits <id|label> <rpm> <concurrency>
 *
 * The CLI writes SQLite directly, so it also works while the server is running;
 * the next request reads the updated row.
 */

import {
  createUser,
  getUserById,
  getUserByLabel,
  listUsers,
  revokeUser,
  rotateUserKey,
  updateUserLimits,
  type PublicUser,
  type UserRole,
} from "../core/users.ts";

function usage(): never {
  console.error(
    "Usage:\n" +
      "  npm run users list\n" +
      "  npm run users create <label> [--rpm N] [--concurrency N] [--admin]\n" +
      "  npm run users revoke <id|label>\n" +
      "  npm run users rotate <id|label>\n" +
      "  npm run users limits <id|label> <rpm> <concurrency>",
  );
  process.exit(1);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function resolveUser(ref: string): PublicUser {
  const user = getUserById(ref) ?? getUserByLabel(ref);
  if (!user) fail(`Unknown user: ${ref}`);
  return user;
}

function parseNonNegative(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    fail(`${name} must be a non-negative integer`);
  }
  return Number(value);
}

function status(user: PublicUser): string {
  return user.revoked_at ? `revoked:${user.revoked_at}` : "active";
}

function printUser(user: PublicUser): void {
  console.log(
    `${user.id}\t${user.label}\t${user.role}\t${user.prefix}...\trpm=${user.rate_limit_rpm}\tconcurrency=${user.max_concurrency}\t${status(user)}`,
  );
}

function cmdList(): void {
  const users = listUsers();
  if (users.length === 0) {
    console.log("No users configured.");
    return;
  }
  for (const user of users) {
    printUser(user);
  }
}

function cmdCreate(label: string, args: string[]): void {
  let rpm: number | undefined;
  let concurrency: number | undefined;
  let role: UserRole = "user";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--admin":
        role = "admin";
        break;
      case "--rpm":
        if (i + 1 >= args.length) usage();
        rpm = parseNonNegative(args[++i], "rpm");
        break;
      case "--concurrency":
        if (i + 1 >= args.length) usage();
        concurrency = parseNonNegative(args[++i], "concurrency");
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }

  const created = createUser(label, { role, rpm, concurrency });
  console.log(`Created user ${created.user.id} (${created.user.label})`);
  console.log(`API key: ${created.apiKey}`);
  console.log("Store it now; it cannot be displayed again.");
}

function cmdRevoke(ref: string): void {
  const user = resolveUser(ref);
  if (!revokeUser(user.id)) {
    fail(`User already revoked: ${user.id} (${user.label})`);
  }
  console.log(`Revoked user ${user.id} (${user.label})`);
}

function cmdRotate(ref: string): void {
  const user = resolveUser(ref);
  const rotated = rotateUserKey(user.id);
  console.log(`Rotated key for ${rotated.user.id} (${rotated.user.label})`);
  console.log(`API key: ${rotated.apiKey}`);
  console.log("Store it now; it cannot be displayed again.");
}

function cmdLimits(ref: string, rpmRaw: string, concurrencyRaw: string): void {
  const user = resolveUser(ref);
  const rpm = parseNonNegative(rpmRaw, "rpm");
  const concurrency = parseNonNegative(concurrencyRaw, "concurrency");
  const updated = updateUserLimits(user.id, rpm, concurrency);
  console.log(
    `Updated ${updated.id} (${updated.label}): rpm=${updated.rate_limit_rpm} concurrency=${updated.max_concurrency}`,
  );
}

function main(): void {
  const [, , command, ...args] = process.argv;
  switch (command) {
    case "list":
      cmdList();
      break;
    case "create":
      if (args.length < 1) usage();
      cmdCreate(args[0], args.slice(1));
      break;
    case "revoke":
      if (args.length < 1) usage();
      cmdRevoke(args[0]);
      break;
    case "rotate":
      if (args.length < 1) usage();
      cmdRotate(args[0]);
      break;
    case "limits":
      if (args.length < 3) usage();
      cmdLimits(args[0], args[1], args[2]);
      break;
    default:
      usage();
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
