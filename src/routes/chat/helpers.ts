import { Usage } from "../../utils/types.ts";

export interface DeltaResult {
  delta: string;
  matchedContent: string;
  contentLength: number;
  contentSuffix: string;
}

let suffixCopyChars = 0;
let escapeDecodePasses = 0;
let sseScanChars = 0;

export function resetHotPathCounters(): void {
  suffixCopyChars = 0;
  escapeDecodePasses = 0;
  sseScanChars = 0;
}

export function getSuffixCopyChars(): number {
  return suffixCopyChars;
}

export function getEscapeDecodePasses(): number {
  return escapeDecodePasses;
}

export function getSseScanChars(): number {
  return sseScanChars;
}

export function decodeSseContentBody(body: string): string {
  escapeDecodePasses += 1;
  return JSON.parse(`"${body}"`) as string;
}

const SUFFIX_WINDOW = 32;

function suffixAfterAppend(previousSuffix: string, added: string): string {
  if (added.length >= SUFFIX_WINDOW) return added.slice(-SUFFIX_WINDOW);
  return previousSuffix.slice(-(SUFFIX_WINDOW - added.length)) + added;
}

function buildDeltaResult(
  delta: string,
  matchedContent: string,
  contentSuffix: string,
): DeltaResult {
  suffixCopyChars += contentSuffix.length;
  return {
    delta,
    matchedContent,
    contentLength: matchedContent.length,
    contentSuffix,
  };
}

export function getIncrementalDelta(
  oldStr: string,
  newStr: string,
  previousLength = oldStr.length,
  previousSuffix = oldStr.slice(-SUFFIX_WINDOW),
): DeltaResult {
  if (!oldStr) {
    return buildDeltaResult(newStr, newStr, newStr.slice(-SUFFIX_WINDOW));
  }
  if (newStr === oldStr) {
    return buildDeltaResult("", oldStr, previousSuffix);
  }

  // Fast path for cumulative Qwen chunks: validate the old boundary using a
  // short suffix instead of scanning the whole previous content with startsWith.
  // Using 32-byte window (O(1)) since Qwen streams with incremental_output=true.
  if (newStr.length > previousLength && previousLength > 0) {
    const checkLen = Math.min(
      SUFFIX_WINDOW,
      previousLength,
      previousSuffix.length,
    );
    const expectedSuffix = previousSuffix.slice(-checkLen);
    const actualSuffix = newStr.slice(
      previousLength - checkLen,
      previousLength,
    );

    if (expectedSuffix === actualSuffix) {
      return buildDeltaResult(
        newStr.slice(previousLength),
        newStr,
        newStr.slice(-SUFFIX_WINDOW),
      );
    }
  }

  if (newStr.length >= oldStr.length && newStr.startsWith(oldStr)) {
    return buildDeltaResult(
      newStr.substring(oldStr.length),
      newStr,
      newStr.slice(-SUFFIX_WINDOW),
    );
  }

  // Heuristic to detect if newStr is cumulative or incremental. Compare in
  // small segments first to reduce per-character work on long responses.
  const scanWindow = Math.min(2000, oldStr.length);
  let commonPrefixLen = 0;
  const maxLen = Math.min(scanWindow, newStr.length);
  const segmentLen = 64;

  while (commonPrefixLen + segmentLen <= maxLen) {
    if (
      oldStr.slice(commonPrefixLen, commonPrefixLen + segmentLen) !==
      newStr.slice(commonPrefixLen, commonPrefixLen + segmentLen)
    ) {
      break;
    }
    commonPrefixLen += segmentLen;
  }

  while (
    commonPrefixLen < maxLen &&
    oldStr[commonPrefixLen] === newStr[commonPrefixLen]
  ) {
    commonPrefixLen++;
  }

  const threshold = Math.min(scanWindow, 4);
  if (commonPrefixLen >= threshold) {
    return buildDeltaResult(
      newStr.substring(commonPrefixLen),
      newStr,
      newStr.slice(-SUFFIX_WINDOW),
    );
  }

  // Treat as strictly incremental to avoid false-positive corruptions
  return buildDeltaResult(
    newStr,
    oldStr + newStr,
    suffixAfterAppend(previousSuffix, newStr),
  );
}

export function formatThinkingSummaryContent(delta: any): string {
  const titles = Array.isArray(delta?.extra?.summary_title?.content)
    ? delta.extra.summary_title.content.filter(
        (item: unknown): item is string => typeof item === "string",
      )
    : [];
  const thoughts = Array.isArray(delta?.extra?.summary_thought?.content)
    ? delta.extra.summary_thought.content.filter(
        (item: unknown): item is string => typeof item === "string",
      )
    : [];

  const sectionCount = Math.max(titles.length, thoughts.length);
  const sections: string[] = [];

  for (let i = 0; i < sectionCount; i++) {
    const title = titles[i]?.trim() || "";
    const thought = thoughts[i]?.trim() || "";

    if (title && thought) {
      sections.push(`**${title}**\n\n${thought}`);
    } else if (title) {
      sections.push(`**${title}**`);
    } else if (thought) {
      sections.push(thought);
    }
  }

  return sections.join("\n\n");
}

/**
 * Verified answer/content phases from Qwen Web:
 * - "answer": standard text completions
 * - "deep_research_answer", "ReportGeneration", "PdfMdGen": deep research & search modes
 * - "image", "image_generation", "image_gen", "t2i": multimodal/image phases
 */
export const ANSWER_PHASES = new Set([
  "answer",
  "deep_research_answer",
  "ReportGeneration",
  "PdfMdGen",
  "slides",
  "image",
  "image_generation",
  "image_gen",
  "t2i",
]);

export function isAnswerPhase(phase: unknown): boolean {
  return typeof phase === "string" && ANSWER_PHASES.has(phase);
}

/**
 * Matches thinking phases verified in upstream Qwen Web HAR:
 * - "thinking_summary": structured thinking in Qwen Max / Plus
 * - "think": incremental thinking deltas in Qwen Omni
 * - "DeepThinking": deep thinking models
 */
export const THINKING_PHASES = new Set([
  "think",
  "thinking_summary",
  "DeepThinking",
  "ResearchPlanning",
]);

export function isThinkingPhase(phase: unknown): boolean {
  return typeof phase === "string" && THINKING_PHASES.has(phase);
}

/**
 * Extract thinking/reasoning text from a delta chunk, supporting both
 * structured summaries (summary_title/summary_thought) and direct content deltas.
 */
export function extractThinkingContent(delta: any): string {
  if (
    Array.isArray(delta?.extra?.summary_title?.content) ||
    Array.isArray(delta?.extra?.summary_thought?.content)
  ) {
    return formatThinkingSummaryContent(delta);
  }
  return typeof delta?.content === "string" ? delta.content : "";
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === "AbortError";
  }

  if (!err || typeof err !== "object") return false;

  const maybeError = err as { name?: unknown; message?: unknown };
  const name = maybeError.name;
  const message = maybeError.message;

  return (
    name === "AbortError" ||
    (typeof message === "string" && /abort(ed)?/i.test(message))
  );
}

export function shouldSuppressStreamAbort(
  err: unknown,
  clientDisconnected: boolean,
  requestAborted: boolean,
  streamStillRegistered: boolean,
): boolean {
  return (
    isAbortError(err) &&
    (clientDisconnected || requestAborted || !streamStillRegistered)
  );
}

export interface UsageAccumulator {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  hasRealPromptTokens: boolean;
  hasRealCompletionTokens: boolean;
  hasRealTotalTokens: boolean;
  cachedPromptTokens: number;
  promptTextTokens?: number;
  reasoningTokens?: number;
  completionTextTokens?: number;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function createUsageAccumulator(
  estimatedPromptTokens: number,
): UsageAccumulator {
  return {
    promptTokens: estimatedPromptTokens,
    completionTokens: 0,
    totalTokens: estimatedPromptTokens,
    hasRealPromptTokens: false,
    hasRealCompletionTokens: false,
    hasRealTotalTokens: false,
    cachedPromptTokens: 0,
  };
}

export function applyUpstreamUsage(
  accumulator: UsageAccumulator,
  candidate: unknown,
): void {
  if (!candidate || typeof candidate !== "object") return;

  const usage = candidate as Record<string, unknown>;
  const promptTokens =
    asFiniteNumber(usage.input_tokens) ?? asFiniteNumber(usage.prompt_tokens);
  const completionTokens =
    asFiniteNumber(usage.output_tokens) ?? asFiniteNumber(usage.completion_tokens);
  const totalTokens = asFiniteNumber(usage.total_tokens);

  if (promptTokens !== null) {
    accumulator.promptTokens = promptTokens;
    accumulator.hasRealPromptTokens = true;
  }

  if (completionTokens !== null) {
    accumulator.completionTokens = completionTokens;
    accumulator.hasRealCompletionTokens = true;
  }

  if (totalTokens !== null) {
    accumulator.totalTokens = totalTokens;
    accumulator.hasRealTotalTokens = true;
  }

  const promptTokensDetails =
    usage.prompt_tokens_details &&
    typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : null;
  const inputTokensDetails =
    usage.input_tokens_details && typeof usage.input_tokens_details === "object"
      ? (usage.input_tokens_details as Record<string, unknown>)
      : null;
  const outputTokensDetails =
    usage.output_tokens_details &&
    typeof usage.output_tokens_details === "object"
      ? (usage.output_tokens_details as Record<string, unknown>)
      : null;

  const cachedTokens = asFiniteNumber(promptTokensDetails?.cached_tokens);
  if (cachedTokens !== null) {
    accumulator.cachedPromptTokens = cachedTokens;
  }

  const promptTextTokens = asFiniteNumber(inputTokensDetails?.text_tokens);
  if (promptTextTokens !== null) {
    accumulator.promptTextTokens = promptTextTokens;
  }

  const reasoningTokens = asFiniteNumber(outputTokensDetails?.reasoning_tokens);
  if (reasoningTokens !== null) {
    accumulator.reasoningTokens = reasoningTokens;
  }

  const completionTextTokens = asFiniteNumber(outputTokensDetails?.text_tokens);
  if (completionTextTokens !== null) {
    accumulator.completionTextTokens = completionTextTokens;
  }
}

export function buildUsage(accumulator: UsageAccumulator): Usage {
  const usage: Usage = {
    prompt_tokens: accumulator.promptTokens,
    completion_tokens: accumulator.completionTokens,
    total_tokens: accumulator.hasRealTotalTokens
      ? accumulator.totalTokens
      : accumulator.promptTokens + accumulator.completionTokens,
    prompt_tokens_details: {
      cached_tokens: accumulator.cachedPromptTokens,
      ...(accumulator.promptTextTokens !== undefined
        ? { text_tokens: accumulator.promptTextTokens }
        : {}),
    },
  };

  if (
    accumulator.reasoningTokens !== undefined ||
    accumulator.completionTextTokens !== undefined
  ) {
    usage.completion_tokens_details = {
      ...(accumulator.reasoningTokens !== undefined
        ? { reasoning_tokens: accumulator.reasoningTokens }
        : {}),
      ...(accumulator.completionTextTokens !== undefined
        ? { text_tokens: accumulator.completionTextTokens }
        : {}),
    };
  }

  return usage;
}

export const SSE_PENDING_WRITE_LIMIT_BYTES = 64 * 1024;

export interface SseWriteBufferOptions {
  flushBytes: number;
  flushMs: number;
  pendingLimitBytes: number;
  isCancelled: () => boolean;
}

export interface SseWriteBuffer {
  write(data: string): void;
  flush(): void;
  drain(): Promise<void>;
  settled(): Promise<void>;
  dispose(): void;
}

export function createSseWriteBuffer(
  sink: (data: string) => Promise<void>,
  options: SseWriteBufferOptions,
): SseWriteBuffer {
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingBytes = 0;
  let chain: Promise<void> = Promise.resolve();
  let writeError: unknown = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    if (options.isCancelled()) {
      buffer = "";
      clearTimer();
      return;
    }
    clearTimer();
    if (buffer) {
      const data = buffer;
      buffer = "";
      pendingBytes += data.length;
      chain = chain.then(() => sink(data)).then(
        () => {
          pendingBytes -= data.length;
        },
        (err) => {
          pendingBytes -= data.length;
          if (writeError === null) writeError = err;
        },
      );
    }
  };

  const write = (data: string) => {
    if (options.isCancelled()) return;
    buffer += data;
    if (buffer.length >= options.flushBytes) {
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, options.flushMs);
    }
  };

  const drain = async () => {
    for (;;) {
      if (writeError !== null) {
        const err = writeError;
        writeError = null;
        throw err;
      }
      if (pendingBytes <= options.pendingLimitBytes || options.isCancelled()) {
        return;
      }
      await chain;
    }
  };

  const settled = async () => {
    for (;;) {
      if (writeError !== null) {
        const err = writeError;
        writeError = null;
        throw err;
      }
      if (pendingBytes === 0 || options.isCancelled()) {
        return;
      }
      await chain;
    }
  };

  const dispose = () => {
    clearTimer();
    buffer = "";
  };

  return { write, flush, drain, settled, dispose };
}

const SSE_CONTENT_LINE =
  /^\{"response_id":"[^"]*","choices":\[\{"delta":\{"content":"((?:[^"\\]|\\.)*)"\}\}\]\}$/;
const SSE_CONTENT_TAIL = '"}}]}';
const SSE_JUNCTION_WINDOW = 32;

export interface SseContentExtraction {
  content: string;
  contentLength: number;
  contentSuffix: string;
  delta: string;
  appended: boolean;
}

export interface SseContentExtractor {
  extract(line: string, emittedLength: number): SseContentExtraction | null;
  reset(): void;
}

export function createSseContentExtractor(): SseContentExtractor {
  let head: string | null = null;
  let bodyLength = 0;
  let bodyHead = "";
  let bodyTail = "";
  let content = "";
  let contentLength = 0;
  let contentSuffix = "";

  const reset = () => {
    head = null;
    bodyLength = 0;
    bodyHead = "";
    bodyTail = "";
    content = "";
    contentLength = 0;
    contentSuffix = "";
  };

  const fullExtract = (line: string): SseContentExtraction | null => {
    sseScanChars += line.length;
    const match = line.match(SSE_CONTENT_LINE);
    if (!match) return null;
    const body = match[1];
    sseScanChars += body.length;
    let decoded: string;
    try {
      decoded = decodeSseContentBody(body);
    } catch {
      reset();
      return null;
    }
    head = line.slice(0, line.length - body.length - SSE_CONTENT_TAIL.length);
    bodyLength = body.length;
    bodyHead = body.slice(0, SSE_JUNCTION_WINDOW);
    bodyTail = body.slice(-SSE_JUNCTION_WINDOW);
    content = decoded;
    contentLength = decoded.length;
    contentSuffix = decoded.slice(-SUFFIX_WINDOW);
    return {
      content,
      contentLength,
      contentSuffix,
      delta: "",
      appended: false,
    };
  };

  const extract = (
    line: string,
    emittedLength: number,
  ): SseContentExtraction | null => {
    if (head === null || emittedLength !== contentLength) {
      return fullExtract(line);
    }
    const bodyStart = head.length;
    const bodyEnd = line.length - SSE_CONTENT_TAIL.length;
    const previousEnd = bodyStart + bodyLength;
    if (bodyEnd <= previousEnd) return fullExtract(line);
    sseScanChars += head.length + SSE_CONTENT_TAIL.length;
    if (!line.startsWith(head) || !line.endsWith(SSE_CONTENT_TAIL)) {
      return fullExtract(line);
    }
    const window = Math.min(SSE_JUNCTION_WINDOW, bodyLength);
    sseScanChars += window * 2;
    if (
      line.slice(bodyStart, bodyStart + window) !== bodyHead ||
      line.slice(previousEnd - window, previousEnd) !== bodyTail
    ) {
      return fullExtract(line);
    }
    const span = line.slice(previousEnd, bodyEnd);
    sseScanChars += span.length;
    let decoded: string;
    try {
      decoded = decodeSseContentBody(span);
    } catch {
      return fullExtract(line);
    }
    content = content + decoded;
    contentLength += decoded.length;
    contentSuffix = suffixAfterAppend(contentSuffix, decoded);
    bodyLength += span.length;
    if (bodyHead.length < SSE_JUNCTION_WINDOW) {
      bodyHead = (bodyHead + span).slice(0, SSE_JUNCTION_WINDOW);
    }
    bodyTail =
      span.length >= SSE_JUNCTION_WINDOW
        ? span.slice(-SSE_JUNCTION_WINDOW)
        : (bodyTail + span).slice(-SSE_JUNCTION_WINDOW);
    return {
      content,
      contentLength,
      contentSuffix,
      delta: decoded,
      appended: true,
    };
  };

  return { extract, reset };
}
