// Gemini (Generative Language API) types plus the internal chat shape they
// translate to and from. Kept local to this adapter so the Gemini surface can
// evolve without tightening the OpenAI request types used by the chat core.

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: {
    mimeType?: string;
    data?: string;
  };
  fileData?: {
    mimeType?: string;
    fileUri?: string;
  };
  functionCall?: {
    name?: string;
    args?: Record<string, unknown>;
  };
  functionResponse?: {
    name?: string;
    response?: unknown;
  };
  [key: string]: unknown;
}

export interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}

export interface GeminiGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  candidateCount?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
  responseLogprobs?: boolean;
  logprobs?: number;
  mediaResolution?: string;
  thinkingConfig?: {
    thinkingBudget?: number;
    includeThoughts?: boolean;
  };
  [key: string]: unknown;
}

export interface GeminiFunctionDeclaration {
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  response?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
  googleSearch?: unknown;
  googleSearchRetrieval?: unknown;
  codeExecution?: unknown;
  urlContext?: unknown;
  [key: string]: unknown;
}

export interface GeminiFunctionCallingConfig {
  mode?: string;
  allowedFunctionNames?: string[];
}

export interface GeminiToolConfig {
  functionCallingConfig?: GeminiFunctionCallingConfig;
}

export interface GeminiSafetySetting {
  category?: string;
  threshold?: string;
  [key: string]: unknown;
}

export interface GeminiRequest {
  model?: string;
  contents?: GeminiContent[];
  systemInstruction?: GeminiContent | string;
  generationConfig?: GeminiGenerationConfig;
  tools?: GeminiTool[];
  toolConfig?: GeminiToolConfig;
  safetySettings?: GeminiSafetySetting[];
  cachedContent?: string;
  labels?: Record<string, string>;
  [key: string]: unknown;
}

export interface GeminiCandidate {
  content: {
    role: "model";
    parts: GeminiPart[];
  };
  finishReason?: GeminiFinishReason;
  index: number;
  safetyRatings?: unknown[];
}

export type GeminiFinishReason =
  | "STOP"
  | "MAX_TOKENS"
  | "SAFETY"
  | "RECITATION"
  | "BLOCKLIST"
  | "PROHIBITED_CONTENT"
  | "SPII"
  | "MALFORMED_FUNCTION_CALL"
  | "OTHER";

export interface GeminiUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount?: number;
  totalTokenCount: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

export interface GeminiResponse {
  candidates: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
  promptFeedback?: {
    blockReason?: string;
    safetyRatings?: unknown[];
  };
}

export interface GeminiErrorEnvelope {
  error: {
    code: number;
    message: string;
    status: string;
    details?: unknown[];
  };
}

// --- Internal OpenAI-compatible shapes ---

export interface ChatContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
  video_url?: { url: string };
  audio_url?: { url: string };
  file_url?: { url: string };
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | ChatContentPart[];
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
}

export interface ChatFunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type ChatToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  n?: number;
  reasoning_effort?: string;
  response_format?: Record<string, unknown>;
  tools?: ChatFunctionTool[];
  tool_choice?: ChatToolChoice;
}

export interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: ChatToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

export interface TranslationWarning {
  field: string;
  reason: string;
  action: string;
}
