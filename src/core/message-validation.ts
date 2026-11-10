import { ValidationError } from "./errors.ts";

/**
 * Validate the OpenAI `messages` array shape shared by the chat route and the
 * async task surface. Throws a 400 `ValidationError` carrying the offending
 * parameter when the field is missing, empty, or an item lacks a usable role.
 */
export function validateMessagesField(
  messages: unknown,
): asserts messages is Array<{ role: string }> {
  if (!Array.isArray(messages) || messages.length === 0) {
    const error = new ValidationError(
      "Field 'messages' must be a non-empty array",
    );
    error.param = "messages";
    throw error;
  }
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i] as unknown;
    if (
      !message ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      typeof (message as Record<string, unknown>).role !== "string" ||
      ((message as Record<string, unknown>).role as string).trim() === ""
    ) {
      const error = new ValidationError(
        `Field 'messages[${i}].role' must be a non-empty string`,
      );
      error.param = `messages[${i}].role`;
      throw error;
    }
  }
}
