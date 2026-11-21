import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import {
  getUtcDateString,
  recordTurnUsage,
  getAccountDailyUsage,
  getModelQuotaWeight,
} from "../core/daily-usage.ts";
import { getDatabase } from "../core/database.ts";

test("getUtcDateString formats UTC date correctly", () => {
  const t1 = new Date("2026-10-01T23:59:00.000Z").getTime();
  assert.equal(getUtcDateString(t1), "2026-10-01");

  const t2 = new Date("2026-10-02T00:01:00.000Z").getTime();
  assert.equal(getUtcDateString(t2), "2026-10-02");
});

test("getModelQuotaWeight scales model outputs according to empirical calibration", () => {
  // Max family: 500k / 280k = 1.7857x
  const maxWeight = getModelQuotaWeight("qwen3.8-max");
  assert.equal(Number(maxWeight.toFixed(4)), 1.7857);

  // Plus family: 500k / 500k = 1.0x
  const plusWeight = getModelQuotaWeight("qwen3.7-plus");
  assert.equal(plusWeight, 1.0);

  // Omni family: 500k / 620k = 0.8065x
  const omniWeight = getModelQuotaWeight("qwen3.8-omni-flash");
  assert.equal(Number(omniWeight.toFixed(4)), 0.8065);

  // Client aliases:
  // claude-3-7-sonnet or gpt-4o map to Max tier -> 1.7857x
  const sonnetWeight = getModelQuotaWeight("claude-3-7-sonnet");
  assert.equal(Number(sonnetWeight.toFixed(4)), 1.7857);

  // claude-3-5-haiku maps to Plus tier -> 1.0x
  const haikuWeight = getModelQuotaWeight("claude-3-5-haiku");
  assert.equal(haikuWeight, 1.0);
});

test("recordTurnUsage calculates exact calibrated percentages per model family", () => {
  const accMax = "test-acc-max-" + Date.now();
  const accPlus = "test-acc-plus-" + Date.now();
  const accOmni = "test-acc-omni-" + Date.now();
  const accMixed = "test-acc-mixed-" + Date.now();
  const db = getDatabase();

  try {
    // 1. Max: 280,000 output tokens must hit exactly 100%
    recordTurnUsage(accMax, { prompt_tokens: 1000, completion_tokens: 280_000 }, "qwen3.8-max");
    const usageMax = getAccountDailyUsage(accMax);
    assert.equal(usageMax.usagePercent, 100, "Max with 280k tokens should be 100%");

    // 2. Plus: 500,000 output tokens must hit exactly 100%
    recordTurnUsage(accPlus, { prompt_tokens: 1000, completion_tokens: 500_000 }, "qwen3.7-plus");
    const usagePlus = getAccountDailyUsage(accPlus);
    assert.equal(usagePlus.usagePercent, 100, "Plus with 500k tokens should be 100%");

    // 3. Omni: 620,000 output tokens must hit exactly 100%
    recordTurnUsage(accOmni, { prompt_tokens: 1000, completion_tokens: 620_000 }, "qwen3.8-omni-flash");
    const usageOmni = getAccountDailyUsage(accOmni);
    assert.equal(usageOmni.usagePercent, 100, "Omni with 620k tokens should be 100%");

    // 4. Mixed: 140,000 Max (50%) + 250,000 Plus (50%) = 100%
    recordTurnUsage(accMixed, { prompt_tokens: 500, completion_tokens: 140_000 }, "qwen3.8-max");
    const halfUsage = getAccountDailyUsage(accMixed);
    assert.equal(halfUsage.usagePercent, 50, "140k Max should be 50%");

    recordTurnUsage(accMixed, { prompt_tokens: 500, completion_tokens: 250_000 }, "qwen3.7-plus");
    const fullUsage = getAccountDailyUsage(accMixed);
    assert.equal(fullUsage.usagePercent, 100, "140k Max + 250k Plus should be 100%");
  } finally {
    db.prepare("DELETE FROM account_daily_usage WHERE account_id IN (?, ?, ?, ?)").run(
      accMax, accPlus, accOmni, accMixed
    );
  }
});
