import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "../core/config.ts";

const serverSource = readFileSync(
  fileURLToPath(new URL("../api/server.ts", import.meta.url)),
  "utf8",
);

test("shutdown: the HTTP drain starts before the browser is closed", () => {
  const drainIdx = serverSource.indexOf("activeServer.close(");
  const browserIdx = serverSource.indexOf("await closeAllPlaywright()");
  assert.ok(drainIdx > 0, "expected an explicit server drain");
  assert.ok(browserIdx > 0, "expected a browser teardown");
  assert.ok(
    drainIdx < browserIdx,
    "in-flight SSE streams need the browser: the drain must come first",
  );
});

test("shutdown: signal handling has a bounded forced exit", () => {
  assert.ok(
    serverSource.includes("Forced shutdown after"),
    "handleSignal must arm a forced-exit deadline",
  );
  assert.ok(
    config.server.shutdownGraceMs >= 1000,
    "the forced-exit grace period must be a real bound",
  );
});

test("shutdown: signal handlers are installed before account warmup", () => {
  const handlersIdx = serverSource.indexOf("installSignalHandlers();");
  const warmupIdx = serverSource.indexOf("startupWarmAccounts");
  assert.ok(handlersIdx > 0);
  assert.ok(warmupIdx > 0);
  assert.ok(
    handlersIdx < warmupIdx,
    "a signal during warmup must still run cleanup",
  );
});
