/**
 * Shared HTTP-status ↔ QwenProxyError mapping.
 *
 * Both the error serializer and the classifier need to agree on the status a
 * client will receive. Keeping the mapping in one module avoids an import
 * cycle (`error-helpers` → `error-classifier` → `error-helpers`) and keeps
 * logs/metrics consistent with the emitted response.
 */

import type { QwenProxyStatusCode } from "../core/errors.js";
import {
  QwenProxyError,
  ValidationError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  UpstreamRateLimit,
  UpstreamError,
  UpstreamTimeout,
  InternalError,
  ClientAbortedError,
  ServiceUnavailable,
} from "../core/errors.js";

export const VALID_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 429, 499, 500, 502, 503, 504,
]);

export function isValidStatus(code: number): code is QwenProxyStatusCode {
  return VALID_STATUSES.has(code);
}

export function errorForStatus(
  status: QwenProxyStatusCode,
  message: string,
): QwenProxyError {
  switch (status) {
    case 400:
      return new ValidationError(message);
    case 401:
      return new AuthError(message);
    case 403:
      return new ForbiddenError(message);
    case 404:
      return new NotFoundError(message);
    case 429:
      return new UpstreamRateLimit(message);
    case 499:
      return new ClientAbortedError(message);
    case 500:
      return new InternalError(message);
    case 502:
      return new UpstreamError(message);
    case 503:
      return new ServiceUnavailable(message);
    case 504:
      return new UpstreamTimeout(message);
  }
}

/**
 * `QwenUpstreamError` extends UpstreamError (502) for legacy retry handling,
 * but the concrete upstream status/category is the useful client-facing
 * contract. Rebuild the error when the hint adds information, while keeping
 * the original message and `param`.
 *
 * `rewriteSameStatus` opts into replacing the category code even when the
 * hint matches the current status (used for emitted responses). Classifiers
 * keep the original instance for same-status errors so retry/identity checks
 * that pass through known QwenProxyError objects stay stable.
 */
export function applyUpstreamHint(
  err: QwenProxyError,
  options: { rewriteSameStatus?: boolean } = {},
): QwenProxyError {
  const hint = (err as { upstreamStatus?: unknown }).upstreamStatus;
  if (typeof hint !== "number" || !isValidStatus(hint)) return err;

  const rawCode = (err as { upstreamCode?: unknown }).upstreamCode;
  const upstreamCode =
    typeof rawCode === "string" && rawCode.length > 0 ? rawCode : undefined;
  if (hint === err.statusCode && !(options.rewriteSameStatus && upstreamCode)) {
    return err;
  }

  const remapped = errorForStatus(hint, err.message);
  if (err.param) remapped.param = err.param;
  if (upstreamCode) {
    (remapped as { code: string }).code = upstreamCode;
  }
  return remapped;
}
