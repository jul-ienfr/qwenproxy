import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureModelLimitsLoaded,
  getModelLimit,
  isModelLimitStateLoaded,
  normalizeModelLimitId,
  resetModelLimitLoadStateForTests,
} from "../core/account-model-limits.ts";

test("model limits: a failed first load does not mark the state as loaded", () => {
  resetModelLimitLoadStateForTests();
  const loaded = ensureModelLimitsLoaded(() => {
    throw new Error("database is locked");
  });
  assert.equal(loaded, false);
  assert.equal(
    isModelLimitStateLoaded(),
    false,
    "state must not be considered loaded after a failed load",
  );
});

test("model limits: a later successful load restores and enforces the hold", () => {
  resetModelLimitLoadStateForTests();
  const model = normalizeModelLimitId("qwen3-coder-plus");
  const until = Date.now() + 60_000;
  const loaded = ensureModelLimitsLoaded(() => [
    {
      account_id: "account-1",
      model,
      until,
      reason: "MembershipLimit",
      updated_at: Date.now(),
    },
  ]);
  assert.equal(loaded, true);
  assert.equal(isModelLimitStateLoaded(), true);

  const entry = getModelLimit("account-1", "qwen3-coder-plus");
  assert.ok(entry, "persisted hold must be visible after a successful load");
  assert.equal(entry.until, until);
});

test("model limits: expired rows are skipped", () => {
  resetModelLimitLoadStateForTests();
  const model = normalizeModelLimitId("qwen3-coder-plus");
  ensureModelLimitsLoaded(() => [
    {
      account_id: "account-2",
      model,
      until: Date.now() - 1,
      reason: "MembershipLimit",
      updated_at: Date.now() - 1000,
    },
  ]);
  assert.equal(getModelLimit("account-2", "qwen3-coder-plus"), null);
});
