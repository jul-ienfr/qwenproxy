/**
 * Upstream SSE error extraction.
 *
 * The internal `/v1/chat/completions` stream signals a failure after the HTTP
 * response is already committed with a terminal `data: {"error":{...}}` frame.
 * Protocol adapters that re-stream that response must surface the failure
 * instead of treating the missing `choices` as a clean end of stream.
 */

export interface SseErrorPayload {
  message: string;
  code: string;
  type?: string;
}

/** Extract the error object from an OpenAI-style SSE chunk, if present. */
export function extractSseError(chunk: unknown): SseErrorPayload | null {
  if (!chunk || typeof chunk !== "object") return null;
  const error = (chunk as { error?: unknown }).error;
  if (!error) return null;

  if (typeof error === "string") {
    return { message: error, code: "upstream_error" };
  }
  if (typeof error !== "object" || Array.isArray(error)) return null;

  const record = error as Record<string, unknown>;
  const message =
    typeof record.message === "string" && record.message
      ? record.message
      : "Upstream stream error";
  const rawCode = record.code ?? record.type;
  const code =
    typeof rawCode === "string" && rawCode ? rawCode : "upstream_error";
  const type = typeof record.type === "string" ? record.type : undefined;

  return { message, code, ...(type ? { type } : {}) };
}

/**
 * Map an SSE error payload to an HTTP-ish status so adapters can emit their
 * native error metadata. The original status is not available once streaming
 * has started, so this uses the error code/type as a best-effort classifier.
 */
export function statusForSseError(error: SseErrorPayload): number {
  const normalized = `${error.code} ${error.type ?? ""}`.toLowerCase();
  if (normalized.includes("rate") || normalized.includes("quota")) return 429;
  if (normalized.includes("not_found")) return 404;
  if (
    normalized.includes("invalid") ||
    normalized.includes("bad_request")
  ) {
    return 400;
  }
  return 502;
}
