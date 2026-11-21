/**
 * JSON Schema definition following the OpenAI function calling spec.
 */
export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  description?: string;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  not?: JsonSchema;
  if?: JsonSchema;
  then?: JsonSchema;
  else?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  nullable?: boolean;
}

/**
 * OpenAI-compatible function tool definition.
 */
export interface FunctionToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: JsonSchema;
    strict?: boolean;
  };
}

/** Tool choice options */
export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "function";
      function: { name: string };
    };

// --- Message Types ---

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface MessageToolCall {
  id: string;
  type: "function";
  function: ToolCallFunction;
}

export interface Message {
  role: string;
  content: string | null;
  /** Present on assistant messages that invoked tools */
  tool_calls?: MessageToolCall[];
  /** Present on tool/function response messages to link back to a call */
  tool_call_id?: string;
  /** Present on tool/function response messages */
  name?: string;
  /** Reasoning content for thinking models */
  reasoning_content?: string;
}

// --- Request Types ---

export interface OpenAIRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  /** QwenProxy media extension used by image/video chat models. */
  size?: string;
  tools?: FunctionToolDefinition[];
  tool_choice?: ToolChoice;
  user?: string;
  session_id?: string;
  conversation_id?: string;
  /** OpenAI chat spec: none|minimal|low|medium|high|xhigh|max (reasoning models). */
  reasoning_effort?: string | null;
  /** camelCase alias overlaid by OpenCode-style configs. */
  reasoningEffort?: string | null;
  /** Opt-in Qwen web search for this request. */
  web_search?: boolean;
  /** Presence also enables search, matching OpenAI's web search options. */
  web_search_options?: Record<string, unknown>;
  stream_options?: {
    include_usage?: boolean;
  };
}

// --- Response Types ---

export interface ToolCall {
  index: number;
  id?: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChoiceDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];
}

export interface Choice {
  index: number;
  delta?: ChoiceDelta;
  message?: ChoiceDelta;
  finish_reason: string | null;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
    text_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    text_tokens?: number;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
}

/**
 * Qwen file format for images
 */
export interface QwenFileEntry {
  type: string;
  file: {
    created_at: number;
    data: Record<string, unknown>;
    filename: string;
    hash: string | null;
    id: string;
    user_id: string;
    meta: { name: string; size: number; content_type: string };
    update_at: number;
    lastModified: number;
    name: string;
    webkitRelativePath: string;
    size: number;
    type: string;
  };
  id: string;
  url: string;
  name: string;
  collection_name: string;
  progress: number;
  status: string;
  greenNet: string;
  size: number;
  error: string;
  itemId: string;
  file_type: string;
  showType: string;
  file_class: string;
  uploadTaskId: string;
}
