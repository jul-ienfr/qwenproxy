import test from "node:test";
import assert from "node:assert/strict";
import {
  createGuardHandlers,
  isBenignTeardownError,
} from "../core/process-guard.ts";

test("process guard: browser/CDP teardown errors are benign", () => {
  assert.equal(
    isBenignTeardownError(
      new Error(
        "Protocol error (Network.setCacheDisabled): Internal server error, session closed.",
      ),
    ),
    true,
  );
  assert.equal(
    isBenignTeardownError(new Error("Target page, context or browser has been closed")),
    true,
  );
  assert.equal(
    isBenignTeardownError(new Error("storageState timed out after 5000ms")),
    true,
  );
});

test("process guard: generic messages are NOT benign", () => {
  assert.equal(isBenignTeardownError(new Error("Connection closed")), false);
  assert.equal(isBenignTeardownError(new Error("Assertion error")), false);
  assert.equal(isBenignTeardownError(new Error("boom")), false);
  assert.equal(isBenignTeardownError(undefined), false);
  assert.equal(isBenignTeardownError(null), false);
  assert.equal(isBenignTeardownError({}), false);
  assert.equal(isBenignTeardownError(""), false);
});

test("process guard: a Playwright stack is accepted as teardown evidence", () => {
  const error = new Error("something odd");
  error.stack = "Error: something odd\n    at ChromiumBrowser.close (patchright/lib/server.js:1:1)";
  assert.equal(isBenignTeardownError(error), true);
});

test("process guard: non-benign failures are fatal, benign teardown is not", () => {
  const fatal: Array<{ kind: string; error: unknown }> = [];
  const handlers = createGuardHandlers("Test", (kind, error) => {
    fatal.push({ kind, error });
  });

  handlers.onUncaught(new Error("TypeError: Cannot read property of undefined"));
  assert.equal(fatal.length, 1);
  assert.equal(fatal[0].kind, "uncaughtException");

  handlers.onRejection(new Error("unhandled boom"));
  assert.equal(fatal.length, 2);
  assert.equal(fatal[1].kind, "unhandledRejection");

  handlers.onUncaught(new Error("Target page, context or browser has been closed"));
  handlers.onRejection(new Error("Protocol error (Page.navigate): session closed"));
  assert.equal(fatal.length, 2, "benign teardown must not be fatal");
});
