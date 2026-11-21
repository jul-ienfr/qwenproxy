export type { JsonSchema, FunctionToolDefinition } from "../utils/types.ts";

/**
 * A parsed tool call from the LLM response.
 */
export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
