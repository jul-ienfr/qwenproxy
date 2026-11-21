import test from "node:test";
import assert from "node:assert";
import { isRetryableFetchErrorMessage, QwenNetworkError } from "../services/qwen.ts";
import { isNetworkLikeError, classifyRetryAction } from "../routes/chat/retry-policy.ts";
import { classifyError } from "../api/error-classifier.ts";
import { UpstreamError, InternalError } from "../core/errors.ts";

// Reproduces the "request hangs forever" symptom from the 2026-08-09 server
// log: the completion fetch never received response headers (upstream/WAF
// swallowed the POST) and the stall was classified as a terminal 500, forcing
// the client to retry in a loop. Both the header-wait timeout and the
// stream idle-abort must be RETRYABLE so the bridge auto-rotates accounts.
test("stall: header-wait timeout is classified retryable (rotates account)", () => {
  assert.strictEqual(
    isRetryableFetchErrorMessage(
      "Qwen browser stream timed out waiting for response headers after 60000ms",
    ),
    true,
    "no-first-byte stall must be retryable, not a terminal error",
  );
});

test("stall: stream idle-abort is classified retryable (etimedout marker)", () => {
  assert.strictEqual(
    isRetryableFetchErrorMessage(
      "Qwen stream abc etimedout (idle timeout after 600000ms without upstream data)",
    ),
    true,
  );
});

test("stall: non-stall errors are NOT over-matched", () => {
  assert.strictEqual(
    isRetryableFetchErrorMessage("model not found: qwen3.7-plus"),
    false,
  );
  assert.strictEqual(
    isRetryableFetchErrorMessage("chat is not exist"),
    false,
  );
  assert.strictEqual(
    isRetryableFetchErrorMessage("WAF challenge"),
    false,
  );
});

test("stall: retry-policy treats the idle-abort as a network-like error", () => {
  assert.strictEqual(
    isNetworkLikeError(
      new Error(
        "Qwen stream abc etimedout (idle timeout after 600000ms without upstream data)",
      ),
    ),
    true,
  );
});

test("stall: QwenNetworkError header timeout is retryable with account switch", () => {
  const policy = classifyRetryAction(
    new QwenNetworkError(
      "Qwen browser stream timed out waiting for response headers after 60000ms",
    ),
  );
  assert.strictEqual(policy.retryable, true);
  assert.strictEqual(policy.switchAccount, true);
});

test("stall: header timeout surfaces as retryable UpstreamError, not 500 InternalError", () => {
  const classified = classifyError(
    new QwenNetworkError(
      "Qwen browser stream timed out waiting for response headers after 60000ms",
    ),
  );
  assert.ok(classified instanceof UpstreamError, "must not be InternalError (500)");
  assert.ok(!(classified instanceof InternalError));
});

test("stall: browser stream ended before response headers is treated as network-like error", () => {
  assert.strictEqual(
    isNetworkLikeError(
      new Error(
        "Browser Qwen stream ended before response headers after 90000ms",
      ),
    ),
    true,
  );
  assert.strictEqual(
    isNetworkLikeError(
      new Error(
        "Qwen browser stream timed out waiting for response headers after 70000ms",
      ),
    ),
    true,
  );
});

test("stall: isBenignTeardownError requires browser/CDP evidence and is fail-closed", async () => {
  const { isBenignTeardownError } = await import("../core/process-guard.ts");
  assert.strictEqual(isBenignTeardownError({}), false);
  assert.strictEqual(isBenignTeardownError(new Error("Target page, context or browser has been closed")), true);
  assert.strictEqual(isBenignTeardownError(new Error("Protocol error: Session closed")), true);
  assert.strictEqual(isBenignTeardownError(new Error("Real unexpected error")), false);
});

test("stall: abortActiveBrowserStreamsForAccount exists and aborts active account streams without throwing", async () => {
  const { abortActiveBrowserStreamsForAccount } = await import("../services/qwen.ts");
  const count = abortActiveBrowserStreamsForAccount("non-existent-acc-test");
  assert.strictEqual(count, 0);
});

test("stall: in-app Qwen SPA navigation does not abort stream, while auth/punish navigation aborts", async () => {
  const { qwenOrigin } = await import("../services/qwen-url.ts");
  const isSafeSpaUrl = (url: string) =>
    url.startsWith(qwenOrigin()) &&
    !url.includes("/auth") &&
    !url.includes("_____tmd_____") &&
    !url.includes("/punish");

  // In-app chat URL (SPA pushState)
  assert.strictEqual(isSafeSpaUrl(`${qwenOrigin()}/c/a23256c1-e1be-4298-b811-5221c78925f6`), true);
  // Root URL
  assert.strictEqual(isSafeSpaUrl(`${qwenOrigin()}/`), true);
  // In-app settings
  assert.strictEqual(isSafeSpaUrl(`${qwenOrigin()}/settings/personalization`), true);

  // Dangerous external or auth/punish navigations
  assert.strictEqual(isSafeSpaUrl("https://auth.qwen.ai/login"), false);
  assert.strictEqual(isSafeSpaUrl(`${qwenOrigin()}/auth`), false);
  assert.strictEqual(isSafeSpaUrl(`${qwenOrigin()}/_____tmd_____/punish?test`), false);
});
