import test from "node:test";
import assert from "node:assert/strict";
import {
  getEnvSyncWriteCount,
  loadAccounts,
  resetEnvSyncWriteCount,
} from "../core/accounts.ts";

test("B7: a warm account cache issues no synchronous account-table write", () => {
  loadAccounts();
  resetEnvSyncWriteCount();

  for (let i = 0; i < 25; i++) {
    loadAccounts();
  }

  assert.equal(
    getEnvSyncWriteCount(),
    0,
    "reconciliation must stay behind its throttle while the env set is unchanged",
  );
});

test("B7: an env account-set change reconciles exactly once", () => {
  const saved = process.env.QWEN_ACCOUNTS;
  try {
    process.env.QWEN_ACCOUNTS = "b7-probe-entry-without-separator";
    resetEnvSyncWriteCount();

    loadAccounts();
    assert.equal(
      getEnvSyncWriteCount(),
      1,
      "a changed env set must reconcile exactly once",
    );

    for (let i = 0; i < 25; i++) {
      loadAccounts();
    }
    assert.equal(
      getEnvSyncWriteCount(),
      1,
      "the new env set must then be throttled like any other",
    );
  } finally {
    if (saved === undefined) delete process.env.QWEN_ACCOUNTS;
    else process.env.QWEN_ACCOUNTS = saved;
    loadAccounts();
  }
});
