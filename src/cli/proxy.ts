/**
 * Account proxy management CLI.
 *
 * Usage:
 *   npm run proxy list
 *   npm run proxy set <email> <proxy-url>
 *   npm run proxy clear <email>
 *   npm run proxy test <email>
 */

import net from "node:net";
import {
  getAccountByEmail,
  loadAccounts,
  updateAccountProxy,
} from "../core/accounts.ts";
import {
  maskProxyUrl,
  parseProxyUrl,
  resolveProxyUrl,
} from "../core/proxy-config.ts";
import { closePlaywrightForAccount } from "../services/playwright.ts";

function usage(): never {
  console.error(
    "Usage:\n" +
      "  npm run proxy list\n" +
      "  npm run proxy set <email> <proxy-url>\n" +
      "  npm run proxy clear <email>\n" +
      "  npm run proxy test <email>",
  );
  process.exit(1);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function cmdList(): Promise<void> {
  const accounts = loadAccounts();
  if (accounts.length === 0) {
    console.log("No accounts configured.");
    return;
  }
  for (const account of accounts) {
    const repo = account.proxy || "(direct / PROXY_URL)";
    const cooldown =
      account.cooldown_until && account.cooldown_until > Date.now()
        ? `cooldown:${account.cooldown_reason || "unknown"}`
        : "ok";
    console.log(`${account.email}\t${repo}\t${cooldown}`);
  }
}

async function cmdSet(email: string, proxyUrl: string): Promise<void> {
  const account = getAccountByEmail(email);
  if (!account) fail(`Unknown account: ${email}`);
  try {
    parseProxyUrl(proxyUrl);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  updateAccountProxy(account.id, proxyUrl);
  await closePlaywrightForAccount(account.id).catch(() => {});
  console.log(`Proxy set for ${account.email}: ${maskProxyUrl(proxyUrl)}`);
  console.log("The account context was closed; the next request relaunches it.");
}

async function cmdClear(email: string): Promise<void> {
  const account = getAccountByEmail(email);
  if (!account) fail(`Unknown account: ${email}`);
  updateAccountProxy(account.id, null);
  await closePlaywrightForAccount(account.id).catch(() => {});
  console.log(`Proxy cleared for ${account.email}`);
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const done = (error?: Error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done());
    socket.once("timeout", () => done(new Error("timeout")));
    socket.once("error", (error) => done(error));
  });
}

async function cmdTest(email: string): Promise<void> {
  const account = getAccountByEmail(email);
  if (!account) fail(`Unknown account: ${email}`);
  const raw = resolveProxyUrl(account.proxy);
  if (!raw) {
    console.log(`${account.email}: direct connection (no proxy configured)`);
    return;
  }
  const parsed = parseProxyUrl(raw);
  if (!parsed) fail(`Invalid proxy for ${account.email}`);
  const url = new URL(parsed.server);
  const port = Number(url.port);
  try {
    await tcpProbe(url.hostname, port, 5000);
    console.log(`${account.email}: reachable ${parsed.display}`);
  } catch (error) {
    console.error(
      `${account.email}: unreachable ${parsed.display} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  switch (command) {
    case "list":
      await cmdList();
      break;
    case "set":
      if (args.length < 2) usage();
      await cmdSet(args[0], args[1]);
      break;
    case "clear":
      if (args.length < 1) usage();
      await cmdClear(args[0]);
      break;
    case "test":
      if (args.length < 1) usage();
      await cmdTest(args[0]);
      break;
    default:
      usage();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
