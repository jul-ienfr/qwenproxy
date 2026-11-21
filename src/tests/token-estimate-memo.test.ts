import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokenCount,
  getTokenEstimateCounters,
  resetTokenEstimateCounters,
} from "../utils/context-truncation.ts";

test("hot path B8: the same prompt is estimated once", () => {
  resetTokenEstimateCounters();
  const prompt = "x".repeat(50_000);

  const first = estimateTokenCount(prompt);
  const second = estimateTokenCount(prompt);

  assert.equal(first, second);
  const counters = getTokenEstimateCounters();
  assert.equal(counters.misses, 1, "first evaluation must miss");
  assert.equal(counters.hits, 1, "the repeat must be served from the cache");
});

test("hot path B8: distinct prompts each evaluate once", () => {
  resetTokenEstimateCounters();
  for (let i = 0; i < 5; i++) {
    estimateTokenCount(`prompt-${i}-${"y".repeat(200)}`);
  }
  const counters = getTokenEstimateCounters();
  assert.equal(counters.misses, 5);
  assert.equal(counters.hits, 0);
  assert.equal(counters.size, 5);
});

test("hot path B8: the estimate cache is bounded", () => {
  resetTokenEstimateCounters();
  const first = `prompt-oldest-${"z".repeat(200)}`;
  estimateTokenCount(first);
  for (let i = 0; i < 64; i++) {
    estimateTokenCount(`prompt-${i}-${"w".repeat(200)}`);
  }
  const counters = getTokenEstimateCounters();
  assert.ok(
    counters.size <= 32,
    `cache must stay bounded, got ${counters.size}`,
  );
});
