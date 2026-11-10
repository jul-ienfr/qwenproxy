import {
  mapClientModelToQwen,
  parseModelSuffix,
} from "../../core/model-alias.ts";
import { logger } from "../../core/logger.js";
import {
  estimateTokenCountFloat,
} from "../../utils/context-truncation.ts";
import { robustParseJSON } from "../../utils/json.ts";
import type {
  ChatContentPart,
  ChatCompletionResponse,
  ChatFunctionTool,
  ChatMessage,
  ChatRequest,
  ChatToolCall,
  GeminiCandidate,
  GeminiFinishReason,
  GeminiGenerationConfig,
  GeminiPart,
  GeminiRequest,
  GeminiResponse,
  GeminiUsageMetadata,
  TranslationWarning,
} from "./types.ts";

// Re-exported so tests and the route can build the streaming state without
// importing the types module directly.
export interface GeminiStreamState {
  requestModel: string;
  maxOutputTokens?: number;
  /** Text emitted to the client so far (used for the output budget). */
  text: string;
  /** Unrounded token estimate for `text`. */
  textTokens: number;
  budgetExceeded: boolean;
  reasoning: string;
  toolCalls: Map<
    number,
    { id?: string; name: string; arguments: string }
  >;
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  terminalEmitted: boolean;
}

const GEMINI_TOP_LEVEL_FIELDS = new Set([
  "model",
  "contents",
  "systemInstruction",
  "generationConfig",
  "tools",
  "toolConfig",
  "safetySettings",
  "cachedContent",
  "labels",
  "stream",
]);

const GEMINI_GENERATION_CONFIG_FIELDS = new Set([
  "temperature",
  "topP",
  "topK",
  "candidateCount",
  "maxOutputTokens",
  "stopSequences",
  "presencePenalty",
  "frequencyPenalty",
  "seed",
  "responseMimeType",
  "responseSchema",
  "responseLogprobs",
  "logprobs",
  "mediaResolution",
  "thinkingConfig",
]);

function addWarning(
  warnings: TranslationWarning[],
  field: string,
  reason: string,
  action: string,
): void {
  warnings.push({ field, reason, action });
}

/**
 * Resolve a Gemini model name (optionally prefixed with `models/`) to a Qwen
 * model id. Gemini families are aliased by tier; direct Qwen ids pass through.
 * Reasoning/search suffixes survive the mapping so `-fast`, `-thinking` and
 * `-search` keep working exactly like the OpenAI/Anthropic routes.
 */
export function mapGeminiModel(model: string): string {
  const normalized = (model || "").trim().replace(/^models\//, "");
  if (!normalized) return "";

  const { baseModel, reasoningMode, search } = parseModelSuffix(normalized);
  const mapped = mapClientModelToQwen(baseModel);

  const suffixes: string[] = [];
  if (search) suffixes.push("search");
  if (reasoningMode === "fast") suffixes.push("fast");
  else if (reasoningMode === "thinking") suffixes.push("thinking");

  return suffixes.length > 0 ? `${mapped}-${suffixes.join("-")}` : mapped;
}

export function isSupportedGeminiModel(mappedModel: string): boolean {
  return mappedModel.toLowerCase().startsWith("qwen");
}

function normalizeRole(role: string | undefined): "user" | "assistant" | "tool" {
  const normalized = (role || "user").toLowerCase();
  if (normalized === "model" || normalized === "assistant") return "assistant";
  if (normalized === "function" || normalized === "tool") return "tool";
  return "user";
}

function instructionText(instruction: GeminiRequest["systemInstruction"]): string {
  if (!instruction) return "";
  if (typeof instruction === "string") return instruction;
  const parts = Array.isArray(instruction.parts) ? instruction.parts : [];
  return parts
    .filter((part) => part && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

function mediaPartFromUrl(url: string, mimeType: string): ChatContentPart {
  const mime = (mimeType || "").toLowerCase();
  if (mime.startsWith("video/")) {
    return { type: "video_url", video_url: { url } };
  }
  if (mime.startsWith("audio/")) {
    return { type: "audio_url", audio_url: { url } };
  }
  if (mime.startsWith("image/")) {
    return { type: "image_url", image_url: { url } };
  }
  // Documents (PDF/text) and unknown inline blobs go through the generic file
  // upload path, which detects the real type from the filename/content.
  return { type: "file_url", file_url: { url } };
}

function mediaPartFromInline(part: GeminiPart): ChatContentPart | null {
  const data = part.inlineData?.data;
  if (!data) return null;
  const mimeType = part.inlineData?.mimeType || "application/octet-stream";
  return mediaPartFromUrl(`data:${mimeType};base64,${data}`, mimeType);
}

function mediaPartFromFile(part: GeminiPart): ChatContentPart | null {
  const uri = part.fileData?.fileUri;
  if (!uri) return null;
  return mediaPartFromUrl(uri, part.fileData?.mimeType || "");
}

function stringifyResponseValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function functionResponseContent(response: unknown): string {
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const record = response as Record<string, unknown>;
    if ("error" in record) {
      return `[Tool Error] ${stringifyResponseValue(record.error)}`;
    }
    if ("result" in record) {
      return stringifyResponseValue(record.result);
    }
    if ("output" in record) {
      return stringifyResponseValue(record.output);
    }
  }
  return stringifyResponseValue(response);
}

/**
 * Translate a Gemini generateContent request into the OpenAI chat shape the
 * internal pipeline consumes. Every field that cannot be represented exactly
 * is recorded in `warnings` so the route can expose it to the client instead of
 * dropping it silently.
 */
export function translateGeminiToOpenAI(
  body: GeminiRequest,
  requestModel: string,
): { request: ChatRequest; warnings: TranslationWarning[] } {
  const warnings: TranslationWarning[] = [];
  const messages: ChatMessage[] = [];
  const pendingToolIds = new Map<string, string[]>();
  let syntheticToolId = 0;

  const rememberToolId = (name?: string): string => {
    const id = `call_gemini_${syntheticToolId++}`;
    if (name) {
      const queue = pendingToolIds.get(name) ?? [];
      queue.push(id);
      pendingToolIds.set(name, queue);
    }
    return id;
  };

  const takeToolId = (name?: string): string => {
    if (name) {
      const queue = pendingToolIds.get(name);
      if (queue && queue.length > 0) return queue.shift() as string;
    }
    // Gemini function responses carry a name but no id. When exactly one call
    // is pending, matching by name is enough; otherwise synthesize an id.
    if (pendingToolIds.size === 1) {
      const queue = [...pendingToolIds.values()][0];
      if (queue.length > 0) return queue.shift() as string;
    }
    return `call_gemini_${syntheticToolId++}`;
  };

  const pushFunctionResponses = (
    responses: NonNullable<GeminiPart["functionResponse"]>[],
    field: string,
  ): void => {
    for (const response of responses) {
      messages.push({
        role: "tool",
        tool_call_id: takeToolId(response.name),
        name: response.name || undefined,
        content: functionResponseContent(response.response),
      });
    }
    if (responses.length > 1) {
      addWarning(
        warnings,
        field,
        "multiple functionResponse parts share one content entry",
        "translated as consecutive tool messages",
      );
    }
  };

  const systemText = instructionText(body.systemInstruction);
  if (systemText) {
    messages.push({ role: "system", content: systemText });
  }
  if (
    body.systemInstruction &&
    typeof body.systemInstruction === "object" &&
    Array.isArray(body.systemInstruction.parts) &&
    body.systemInstruction.parts.some((part) => !part.text)
  ) {
    addWarning(
      warnings,
      "systemInstruction",
      "non-text system instruction parts cannot be represented",
      "only text parts were forwarded",
    );
  }

  const contents = Array.isArray(body.contents) ? body.contents : [];
  for (let index = 0; index < contents.length; index++) {
    const content = contents[index];
    if (!content || typeof content !== "object") {
      addWarning(
        warnings,
        `contents[${index}]`,
        "content entry is not an object",
        "ignored",
      );
      continue;
    }

    const rawRole = content.role ?? "user";
    const role = normalizeRole(rawRole);
    if (
      !["user", "model", "assistant", "function", "tool"].includes(
        String(rawRole).toLowerCase(),
      )
    ) {
      addWarning(
        warnings,
        `contents[${index}].role`,
        `unknown role '${rawRole}'`,
        "treated as user",
      );
    }

    const parts = Array.isArray(content.parts) ? content.parts : [];
    const texts: string[] = [];
    const media: ChatContentPart[] = [];
    const functionCalls: NonNullable<GeminiPart["functionCall"]>[] = [];
    const functionResponses: NonNullable<GeminiPart["functionResponse"]>[] = [];
    let thoughtText = "";

    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex];
      if (!part || typeof part !== "object") {
        addWarning(
          warnings,
          `contents[${index}].parts[${partIndex}]`,
          "part is not an object",
          "ignored",
        );
        continue;
      }

      let recognized = false;

      if (typeof part.text === "string") {
        recognized = true;
        if (part.thought && role === "assistant") {
          thoughtText += part.text;
        } else {
          texts.push(part.text);
        }
      }

      if (part.inlineData !== undefined) {
        recognized = true;
        const mediaPart = mediaPartFromInline(part);
        if (mediaPart) {
          media.push(mediaPart);
        } else {
          addWarning(
            warnings,
            `contents[${index}].parts[${partIndex}].inlineData`,
            "inlineData is missing its base64 payload",
            "ignored",
          );
        }
      }

      if (part.fileData !== undefined) {
        recognized = true;
        const mediaPart = mediaPartFromFile(part);
        if (mediaPart) {
          media.push(mediaPart);
        } else {
          addWarning(
            warnings,
            `contents[${index}].parts[${partIndex}].fileData`,
            "fileData is missing its fileUri",
            "ignored",
          );
        }
      }

      if (part.functionCall !== undefined) {
        recognized = true;
        functionCalls.push(part.functionCall);
      }

      if (part.functionResponse !== undefined) {
        recognized = true;
        functionResponses.push(part.functionResponse);
      }

      if (!recognized) {
        const keys = Object.keys(part).join(", ") || "empty part";
        addWarning(
          warnings,
          `contents[${index}].parts[${partIndex}]`,
          `unsupported part (${keys})`,
          "ignored",
        );
      }
    }

    if (role === "assistant") {
      if (media.length > 0) {
        addWarning(
          warnings,
          `contents[${index}]`,
          "media parts in model content cannot be represented in chat history",
          "ignored",
        );
      }

      const text = texts.join("\n");
      const toolCalls: ChatToolCall[] = functionCalls.map((call) => ({
        id: rememberToolId(call.name),
        type: "function",
        function: {
          name: call.name || "",
          arguments: JSON.stringify(call.args ?? {}),
        },
      }));

      if (toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolCalls,
          ...(thoughtText ? { reasoning_content: thoughtText } : {}),
        });
      } else if (text || thoughtText) {
        messages.push({
          role: "assistant",
          content: text || null,
          ...(thoughtText ? { reasoning_content: thoughtText } : {}),
        });
      }

      if (functionResponses.length > 0) {
        pushFunctionResponses(
          functionResponses,
          `contents[${index}].parts`,
        );
      }
    } else if (role === "tool") {
      pushFunctionResponses(functionResponses, `contents[${index}].parts`);
      if (texts.length > 0) {
        messages.push({
          role: "tool",
          tool_call_id: takeToolId(undefined),
          content: texts.join("\n"),
        });
      }
    } else {
      // User turn. Tool responses are emitted first so the assistant tool call
      // and its result stay adjacent in the flattened prompt.
      if (functionResponses.length > 0) {
        pushFunctionResponses(functionResponses, `contents[${index}].parts`);
      }

      if (media.length > 0) {
        const contentParts: ChatContentPart[] = [];
        for (const text of texts) {
          if (text) contentParts.push({ type: "text", text });
        }
        contentParts.push(...media);
        messages.push({ role: "user", content: contentParts });
      } else if (texts.length > 0) {
        messages.push({ role: "user", content: texts.join("\n") });
      }
    }
  }

  const request: ChatRequest = {
    model: mapGeminiModel(requestModel),
    messages,
    stream: false,
  };

  applyGenerationConfig(body.generationConfig, request, warnings);
  applyTools(body, request, warnings);

  if (body.cachedContent) {
    addWarning(
      warnings,
      "cachedContent",
      "explicit context caching is not supported",
      "ignored",
    );
  }
  if (body.labels) {
    addWarning(
      warnings,
      "labels",
      "request labels are not supported",
      "ignored",
    );
  }
  if (body.stream !== undefined) {
    addWarning(
      warnings,
      "stream",
      "streaming is selected by the URL method (:generateContent vs :streamGenerateContent)",
      "ignored",
    );
  }

  for (const key of Object.keys(body)) {
    if (!GEMINI_TOP_LEVEL_FIELDS.has(key)) {
      addWarning(warnings, `body.${key}`, "unknown field", "ignored");
    }
  }

  if (Array.isArray(body.safetySettings) && body.safetySettings.length > 0) {
    addWarning(
      warnings,
      "safetySettings",
      "Qwen does not expose Gemini safety categories or thresholds",
      "approximated by upstream moderation",
    );
  }

  return { request, warnings };
}

function applyGenerationConfig(
  config: GeminiGenerationConfig | undefined,
  request: ChatRequest,
  warnings: TranslationWarning[],
): void {
  if (!config || typeof config !== "object") return;

  if (typeof config.temperature === "number") {
    request.temperature = config.temperature;
  }
  if (typeof config.topP === "number") {
    request.top_p = config.topP;
  }
  if (typeof config.topK === "number" && config.topK > 0) {
    request.top_k = config.topK;
    addWarning(
      warnings,
      "generationConfig.topK",
      "the Qwen web backend does not expose top-k sampling",
      "forwarded but may be ignored upstream",
    );
  }
  if (typeof config.maxOutputTokens === "number") {
    request.max_tokens = config.maxOutputTokens;
    request.max_completion_tokens = config.maxOutputTokens;
  }
  if (Array.isArray(config.stopSequences) && config.stopSequences.length > 0) {
    request.stop = config.stopSequences;
  }
  if (typeof config.presencePenalty === "number") {
    request.presence_penalty = config.presencePenalty;
  }
  if (typeof config.frequencyPenalty === "number") {
    request.frequency_penalty = config.frequencyPenalty;
  }
  if (typeof config.candidateCount === "number") {
    if (config.candidateCount !== 1) {
      addWarning(
        warnings,
        "generationConfig.candidateCount",
        "only one candidate is supported",
        `using 1 instead of ${config.candidateCount}`,
      );
    }
    request.n = 1;
  }
  if (typeof config.seed === "number") {
    addWarning(
      warnings,
      "generationConfig.seed",
      "deterministic sampling seeds are not supported",
      "ignored",
    );
  }
  if (
    config.responseLogprobs !== undefined ||
    config.logprobs !== undefined
  ) {
    addWarning(
      warnings,
      "generationConfig.responseLogprobs",
      "log probabilities are not supported",
      "ignored",
    );
  }
  if (config.mediaResolution !== undefined) {
    addWarning(
      warnings,
      "generationConfig.mediaResolution",
      "media resolution hints are not supported",
      "ignored",
    );
  }

  if (config.responseSchema && typeof config.responseSchema === "object") {
    request.response_format = {
      type: "json_schema",
      json_schema: {
        name: "gemini_response",
        strict: true,
        schema: config.responseSchema,
      },
    };
  } else if (typeof config.responseMimeType === "string") {
    if (config.responseMimeType.toLowerCase().includes("json")) {
      request.response_format = { type: "json_object" };
    } else if (!config.responseMimeType.toLowerCase().startsWith("text/")) {
      addWarning(
        warnings,
        "generationConfig.responseMimeType",
        `unsupported response MIME type '${config.responseMimeType}'`,
        "treated as plain text",
      );
    }
  }

  const thinking = config.thinkingConfig;
  if (thinking && typeof thinking === "object") {
    if (typeof thinking.thinkingBudget === "number") {
      request.reasoning_effort = thinking.thinkingBudget <= 0 ? "none" : "high";
    }
    if (thinking.includeThoughts) {
      addWarning(
        warnings,
        "generationConfig.thinkingConfig.includeThoughts",
        "Qwen only returns thought summaries on models that support them",
        "thought parts are emitted when upstream returns reasoning_content",
      );
    }
  }

  for (const key of Object.keys(config)) {
    if (!GEMINI_GENERATION_CONFIG_FIELDS.has(key)) {
      addWarning(
        warnings,
        `generationConfig.${key}`,
        "unknown field",
        "ignored",
      );
    }
  }
}

function applyTools(
  body: GeminiRequest,
  request: ChatRequest,
  warnings: TranslationWarning[],
): void {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const declarations: ChatFunctionTool[] = [];

  for (let index = 0; index < tools.length; index++) {
    const tool = tools[index];
    if (!tool || typeof tool !== "object") {
      addWarning(
        warnings,
        `tools[${index}]`,
        "tool entry is not an object",
        "ignored",
      );
      continue;
    }

    if (Array.isArray(tool.functionDeclarations)) {
      for (const declaration of tool.functionDeclarations) {
        if (!declaration || typeof declaration !== "object" || !declaration.name) {
          continue;
        }
        declarations.push({
          type: "function",
          function: {
            name: declaration.name,
            description: declaration.description,
            parameters: declaration.parameters,
          },
        });
      }
    }

    for (const key of Object.keys(tool)) {
      if (key === "functionDeclarations") continue;
      addWarning(
        warnings,
        `tools[${index}].${key}`,
        "Gemini built-in tool is not supported",
        "ignored",
      );
    }
  }

  if (declarations.length > 0) {
    request.tools = declarations;
  }

  const callingConfig = body.toolConfig?.functionCallingConfig;
  if (!callingConfig || typeof callingConfig !== "object") return;

  const mode = String(callingConfig.mode || "AUTO").toUpperCase();
  const allowed = Array.isArray(callingConfig.allowedFunctionNames)
    ? callingConfig.allowedFunctionNames
    : [];

  if (mode === "NONE") {
    request.tool_choice = "none";
    return;
  }
  if (mode === "ANY" || mode === "VALIDATED") {
    if (allowed.length === 1) {
      request.tool_choice = {
        type: "function",
        function: { name: allowed[0] },
      };
    } else {
      request.tool_choice = "required";
      if (allowed.length > 1) {
        addWarning(
          warnings,
          "toolConfig.functionCallingConfig.allowedFunctionNames",
          "the upstream tool choice cannot restrict to a subset of functions",
          "using required",
        );
      }
    }
    return;
  }
  if (mode === "AUTO") {
    request.tool_choice = "auto";
    if (allowed.length > 0) {
      addWarning(
        warnings,
        "toolConfig.functionCallingConfig.allowedFunctionNames",
        "function-name allow lists are not enforceable in AUTO mode",
        "ignored",
      );
    }
    return;
  }

  addWarning(
    warnings,
    "toolConfig.functionCallingConfig.mode",
    `unknown mode '${callingConfig.mode}'`,
    "using auto",
  );
  request.tool_choice = "auto";
}

function usageMetadata(usage: ChatCompletionResponse["usage"]): GeminiUsageMetadata {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;
  const metadata: GeminiUsageMetadata = {
    promptTokenCount: promptTokens,
    candidatesTokenCount: completionTokens,
    totalTokenCount: totalTokens,
  };
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoningTokens === "number" && reasoningTokens > 0) {
    metadata.thoughtsTokenCount = reasoningTokens;
  }
  return metadata;
}

export function mapFinishReason(
  finishReason: string | null | undefined,
  hasToolCalls: boolean,
  truncated: boolean,
): GeminiFinishReason {
  if (truncated) return "MAX_TOKENS";
  if (finishReason === "length") return "MAX_TOKENS";
  if (finishReason === "content_filter") return "SAFETY";
  if (finishReason === "tool_calls" || hasToolCalls) return "STOP";
  return "STOP";
}

function parseToolArguments(raw: string | undefined): {
  args: Record<string, unknown>;
  malformed: boolean;
} {
  if (!raw) return { args: {}, malformed: false };
  try {
    const parsed = JSON.parse(raw);
    return normalizeParsedArguments(parsed);
  } catch {
    try {
      const repaired = robustParseJSON(raw);
      return normalizeParsedArguments(repaired);
    } catch {
      return { args: { _raw: raw }, malformed: true };
    }
  }
}

function normalizeParsedArguments(parsed: unknown): {
  args: Record<string, unknown>;
  malformed: boolean;
} {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return { args: parsed as Record<string, unknown>, malformed: false };
  }
  return { args: { value: parsed }, malformed: false };
}

/**
 * Keep at most `budget` estimated tokens of `text`. Used to enforce
 * generationConfig.maxOutputTokens because the Qwen web backend does not expose
 * a hard output-token limit.
 */
export function truncateToTokenBudget(
  text: string,
  budget: number,
): { text: string; truncated: boolean } {
  if (!text) return { text: "", truncated: false };
  if (budget <= 0) return { text: "", truncated: true };
  if (estimateTokenCountFloat(text) <= budget) {
    return { text, truncated: false };
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokenCountFloat(text.slice(0, mid)) <= budget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  let end = low;
  if (end > 0) {
    const code = text.charCodeAt(end - 1);
    // Never split a surrogate pair.
    if (code >= 0xd800 && code <= 0xdbff) end--;
  }
  return { text: text.slice(0, end), truncated: true };
}

/**
 * Translate a non-streaming OpenAI chat completion into a Gemini response.
 */
export function translateOpenAIToGemini(
  response: ChatCompletionResponse,
  requestModel: string,
  options?: { maxOutputTokens?: number },
): GeminiResponse {
  const choice = response.choices?.[0];
  const message = choice?.message;
  const parts: GeminiPart[] = [];

  if (message?.reasoning_content) {
    parts.push({ text: message.reasoning_content, thought: true });
  }

  let text = typeof message?.content === "string" ? message.content : "";
  let truncated = false;
  if (text && options?.maxOutputTokens && options.maxOutputTokens > 0) {
    const limited = truncateToTokenBudget(text, options.maxOutputTokens);
    text = limited.text;
    truncated = limited.truncated;
  }
  if (text) {
    parts.push({ text });
  }

  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls
    : [];
  for (const call of toolCalls) {
    // Tolerate malformed upstream tool-call entries instead of failing the
    // whole non-streaming response.
    if (!call || typeof call !== "object" || !call.function) continue;
    const { args, malformed } = parseToolArguments(call.function?.arguments);
    if (malformed) {
      logger.warn("[Gemini] Malformed tool call arguments from upstream", {
        toolName: call.function?.name,
        rawLength: call.function?.arguments?.length ?? 0,
      });
    }
    parts.push({
      functionCall: {
        name: call.function?.name || "",
        args,
      },
    });
  }

  const candidate: GeminiCandidate = {
    content: { role: "model", parts },
    finishReason: choice
      ? mapFinishReason(choice.finish_reason, toolCalls.length > 0, truncated)
      : "OTHER",
    index: 0,
  };

  const usage = usageMetadata(response.usage);
  // The internal pipeline may enforce the output budget itself (finish_reason
  // "length") or the adapter may have truncated above. Either way the client
  // received a bounded candidate, so report the emitted text plus thought
  // tokens instead of the upstream pre-truncation totals.
  if (truncated || choice?.finish_reason === "length") {
    const thoughts = usage.thoughtsTokenCount ?? 0;
    const emitted = Math.ceil(estimateTokenCountFloat(text));
    usage.candidatesTokenCount = thoughts + emitted;
    usage.totalTokenCount = usage.promptTokenCount + usage.candidatesTokenCount;
  }

  return {
    candidates: [candidate],
    usageMetadata: usage,
    modelVersion: requestModel,
  };
}

export function createGeminiStreamState(
  requestModel: string,
  maxOutputTokens?: number,
): GeminiStreamState {
  return {
    requestModel,
    maxOutputTokens,
    text: "",
    textTokens: 0,
    budgetExceeded: false,
    reasoning: "",
    toolCalls: new Map(),
    finishReason: null,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    terminalEmitted: false,
  };
}

function currentUsage(state: GeminiStreamState): GeminiUsageMetadata {
  const thoughts = state.reasoningTokens ?? 0;
  // When the adapter stopped emitting text at the maxOutputTokens budget or the
  // upstream reported a length stop, the upstream completion count describes
  // output the client never received. Report the emitted text plus thought
  // tokens instead.
  const truncated = state.budgetExceeded || state.finishReason === "length";
  const candidates = truncated
    ? thoughts + Math.ceil(state.textTokens)
    : state.completionTokens;
  const total = truncated
    ? state.promptTokens + candidates
    : state.totalTokens || state.promptTokens + candidates;
  return {
    promptTokenCount: state.promptTokens,
    candidatesTokenCount: candidates,
    totalTokenCount: total,
    ...(thoughts > 0 ? { thoughtsTokenCount: thoughts } : {}),
  };
}

function streamChunk(
  state: GeminiStreamState,
  parts: GeminiPart[],
): GeminiResponse {
  return {
    candidates: [
      {
        content: { role: "model", parts },
        index: 0,
      },
    ],
    modelVersion: state.requestModel,
  };
}

/**
 * Translate one OpenAI streaming chunk into zero or more Gemini chunks.
 * Text and thought deltas are emitted immediately; tool calls are accumulated
 * until finalizeGeminiStream so Gemini receives one complete functionCall part.
 */
export function translateStreamChunk(
  chunk: any,
  state: GeminiStreamState,
): GeminiResponse[] {
  const output: GeminiResponse[] = [];
  const usage = chunk?.usage;
  if (usage) {
    if (typeof usage.prompt_tokens === "number") {
      state.promptTokens = usage.prompt_tokens;
    }
    if (typeof usage.completion_tokens === "number") {
      state.completionTokens = usage.completion_tokens;
    }
    if (typeof usage.total_tokens === "number") {
      state.totalTokens = usage.total_tokens;
    }
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
    if (typeof reasoningTokens === "number") {
      state.reasoningTokens = reasoningTokens;
    }
  }

  const choice = chunk?.choices?.[0];
  const delta = choice?.delta ?? {};

  if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
    state.reasoning += delta.reasoning_content;
    output.push(
      streamChunk(state, [
        { text: delta.reasoning_content, thought: true },
      ]),
    );
  }

  if (typeof delta.content === "string" && delta.content.length > 0) {
    let text = delta.content;

    if (state.maxOutputTokens && state.maxOutputTokens > 0) {
      if (state.budgetExceeded) {
        text = "";
      } else {
        const remaining = state.maxOutputTokens - state.textTokens;
        if (remaining <= 0) {
          state.budgetExceeded = true;
          text = "";
        } else if (estimateTokenCountFloat(text) > remaining) {
          const limited = truncateToTokenBudget(text, remaining);
          text = limited.text;
          state.budgetExceeded = limited.truncated;
        }
      }
    }

    if (text) {
      state.text += text;
      state.textTokens += estimateTokenCountFloat(text);
      output.push(streamChunk(state, [{ text }]));
    }
  }

  if (Array.isArray(delta.tool_calls)) {
    for (const call of delta.tool_calls) {
      // Skip malformed entries rather than throwing away text in this chunk.
      if (!call || typeof call !== "object") continue;
      const index = typeof call.index === "number" ? call.index : 0;
      const entry = state.toolCalls.get(index) ?? {
        name: "",
        arguments: "",
      };
      if (typeof call.id === "string" && call.id) {
        entry.id = call.id;
      }
      if (typeof call.function?.name === "string" && call.function.name) {
        entry.name = call.function.name;
      }
      if (typeof call.function?.arguments === "string") {
        entry.arguments += call.function.arguments;
      }
      state.toolCalls.set(index, entry);
    }
  }

  if (choice?.finish_reason) {
    state.finishReason = choice.finish_reason;
  }

  return output;
}

/**
 * Emit the single terminal Gemini chunk: accumulated functionCall parts,
 * the finish reason and final usage metadata. The route calls this exactly once
 * after the upstream stream ends.
 */
export function finalizeGeminiStream(state: GeminiStreamState): GeminiResponse {
  const parts: GeminiPart[] = [];
  const toolCalls = [...state.toolCalls.entries()].sort(
    (a, b) => a[0] - b[0],
  );

  for (const [, call] of toolCalls) {
    const { args, malformed } = parseToolArguments(call.arguments);
    if (malformed) {
      logger.warn("[Gemini] Malformed streaming tool call arguments", {
        toolName: call.name,
        rawLength: call.arguments.length,
      });
    }
    parts.push({
      functionCall: {
        name: call.name,
        args,
      },
    });
  }

  state.terminalEmitted = true;

  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: mapFinishReason(
          state.finishReason,
          toolCalls.length > 0,
          state.budgetExceeded,
        ),
        index: 0,
      },
    ],
    usageMetadata: currentUsage(state),
    modelVersion: state.requestModel,
  };
}
