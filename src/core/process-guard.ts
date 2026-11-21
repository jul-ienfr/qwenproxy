/**
 * Process teardown error guard.
 *
 * Catches unhandled rejections and uncaught exceptions that arise from
 * benign browser/CDP connection closures (e.g. ProtocolError: session closed,
 * Network.setCacheDisabled, target crashed during shutdown) and prevents
 * them from terminating the Node.js process.
 */

export function isPlaywrightAlreadyClosedMessage(message: string): boolean {
  if (!message) return false;
  return (
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Browser has been closed") ||
    message.includes("Target closed") ||
    message.includes("Target crashed") ||
    message.includes("Page crashed") ||
    message.includes("Assertion error") ||
    message.includes("Cannot find parent object") ||
    message.includes("Connection closed") ||
    message.includes("session closed") ||
    message.includes("Session closed") ||
    message.includes("Network.setCacheDisabled") ||
    message.includes("Protocol error") ||
    message.includes("storageState timed out")
  );
}

const PROCESS_TEARDOWN_ANCHORS = [
  "Target page, context or browser has been closed",
  "Browser has been closed",
  "Target closed",
  "Target crashed",
  "Page crashed",
  "Cannot find parent object",
  "Protocol error",
  "Network.setCacheDisabled",
  "storageState timed out",
];

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error ?? "");
}

/**
 * Stricter than `isPlaywrightAlreadyClosedMessage`: process-fatal decisions
 * require browser/CDP evidence, so a generic "Connection closed" or an empty
 * rejection reason is never swallowed by the process guard.
 */
export function isBenignTeardownError(error: unknown): boolean {
  if (!error) return false;
  const message = describeError(error);
  if (!message) return false;
  if (PROCESS_TEARDOWN_ANCHORS.some((anchor) => message.includes(anchor))) {
    return true;
  }
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  return /playwright|patchright|chromium/i.test(stack);
}

export type ProcessFatalHandler = (
  kind: "uncaughtException" | "unhandledRejection",
  error: unknown,
) => void;

export function createGuardHandlers(
  label: string,
  onFatal: ProcessFatalHandler,
): {
  onUncaught: (error: unknown) => void;
  onRejection: (reason: unknown) => void;
} {
  const reportBenign = (
    kind: "uncaughtException" | "unhandledRejection",
    error: unknown,
  ): void => {
    console.warn(
      `⚠️  [${label}] Handled benign driver teardown ${kind === "uncaughtException" ? "exception" : "rejection"}: ${describeError(error)}`,
    );
  };

  return {
    onUncaught: (error) => {
      if (isBenignTeardownError(error)) {
        reportBenign("uncaughtException", error);
        return;
      }
      onFatal("uncaughtException", error);
    },
    onRejection: (reason) => {
      if (isBenignTeardownError(reason)) {
        reportBenign("unhandledRejection", reason);
        return;
      }
      onFatal("unhandledRejection", reason);
    },
  };
}

let guardsInstalled = false;

/**
 * Installs process-wide handlers for uncaughtException and unhandledRejection.
 * Benign browser/CDP teardown errors are logged and swallowed; anything else is
 * treated as fatal, because an uncaught exception leaves the process in an
 * unverifiable state.
 */
export function installProcessTeardownGuards(
  label = "Process",
  options: { onFatal?: ProcessFatalHandler } = {},
): void {
  if (guardsInstalled) return;
  guardsInstalled = true;

  const onFatal: ProcessFatalHandler =
    options.onFatal ??
    ((kind, error) => {
      console.error(
        `❌ [${label}] ${kind === "uncaughtException" ? "Uncaught Exception" : "Unhandled Rejection"}:`,
        error,
      );
      process.exit(1);
    });

  const handlers = createGuardHandlers(label, onFatal);
  process.on("uncaughtException", handlers.onUncaught);
  process.on("unhandledRejection", handlers.onRejection);
}
