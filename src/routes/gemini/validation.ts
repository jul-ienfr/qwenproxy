export interface ValidationResult {
  valid: boolean;
  error?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const RECOGNIZED_PART_KEYS = [
  "text",
  "inlineData",
  "fileData",
  "functionCall",
  "functionResponse",
] as const;

export function hasRecognizedPart(part: Record<string, unknown>): boolean {
  return RECOGNIZED_PART_KEYS.some((key) => part[key] !== undefined);
}

/**
 * Validate a Gemini generateContent request body.
 *
 * Structural errors are rejected (they cannot be translated), while fields the
 * adapter merely approximates or ignores are left to translateGeminiToOpenAI,
 * which records a TranslationWarning for each one.
 */
export function validateGeminiRequest(body: unknown): ValidationResult {
  if (!isPlainObject(body)) {
    return { valid: false, error: "Request body must be a JSON object" };
  }

  const req = body;

  if (req.model !== undefined && typeof req.model !== "string") {
    return { valid: false, error: "'model' must be a string" };
  }

  if (!Array.isArray(req.contents)) {
    return { valid: false, error: "Missing or invalid 'contents' field" };
  }

  if (req.contents.length === 0) {
    return { valid: false, error: "'contents' array cannot be empty" };
  }

  for (let i = 0; i < req.contents.length; i++) {
    const content = req.contents[i];
    if (!isPlainObject(content)) {
      return { valid: false, error: `contents[${i}] must be an object` };
    }
    if (content.role !== undefined && typeof content.role !== "string") {
      return { valid: false, error: `contents[${i}].role must be a string` };
    }
    if (!Array.isArray(content.parts)) {
      return { valid: false, error: `contents[${i}].parts must be an array` };
    }
    if (content.parts.length === 0) {
      return {
        valid: false,
        error: `contents[${i}].parts array cannot be empty`,
      };
    }

    for (let j = 0; j < content.parts.length; j++) {
      const part = content.parts[j];
      if (!isPlainObject(part)) {
        return {
          valid: false,
          error: `contents[${i}].parts[${j}] must be an object`,
        };
      }
      if (part.text !== undefined && typeof part.text !== "string") {
        return {
          valid: false,
          error: `contents[${i}].parts[${j}].text must be a string`,
        };
      }
      for (const mediaKey of ["inlineData", "fileData"] as const) {
        const media = part[mediaKey];
        if (media !== undefined) {
          if (!isPlainObject(media)) {
            return {
              valid: false,
              error: `contents[${i}].parts[${j}].${mediaKey} must be an object`,
            };
          }
          if (
            media.mimeType !== undefined &&
            typeof media.mimeType !== "string"
          ) {
            return {
              valid: false,
              error: `contents[${i}].parts[${j}].${mediaKey}.mimeType must be a string`,
            };
          }
          if (
            mediaKey === "inlineData" &&
            media.data !== undefined &&
            typeof media.data !== "string"
          ) {
            return {
              valid: false,
              error: `contents[${i}].parts[${j}].inlineData.data must be a string`,
            };
          }
          if (
            mediaKey === "fileData" &&
            media.fileUri !== undefined &&
            typeof media.fileUri !== "string"
          ) {
            return {
              valid: false,
              error: `contents[${i}].parts[${j}].fileData.fileUri must be a string`,
            };
          }
        }
      }
      for (const callKey of ["functionCall", "functionResponse"] as const) {
        const call = part[callKey];
        if (call !== undefined) {
          if (!isPlainObject(call)) {
            return {
              valid: false,
              error: `contents[${i}].parts[${j}].${callKey} must be an object`,
            };
          }
          if (call.name !== undefined && typeof call.name !== "string") {
            return {
              valid: false,
              error: `contents[${i}].parts[${j}].${callKey}.name must be a string`,
            };
          }
        }
      }
    }
  }

  const systemInstruction = req.systemInstruction;
  if (systemInstruction !== undefined) {
    if (typeof systemInstruction === "string") {
      // Accepted.
    } else if (isPlainObject(systemInstruction)) {
      if (
        systemInstruction.parts !== undefined &&
        !Array.isArray(systemInstruction.parts)
      ) {
        return {
          valid: false,
          error: "'systemInstruction.parts' must be an array",
        };
      }
      if (
        Array.isArray(systemInstruction.parts) &&
        systemInstruction.parts.some((part) => !isPlainObject(part))
      ) {
        return {
          valid: false,
          error: "'systemInstruction.parts' entries must be objects",
        };
      }
    } else {
      return {
        valid: false,
        error: "'systemInstruction' must be a string or an object",
      };
    }
  }

  const gc = req.generationConfig;
  if (gc !== undefined) {
    if (!isPlainObject(gc)) {
      return { valid: false, error: "'generationConfig' must be an object" };
    }
    if (gc.temperature !== undefined) {
      if (!isFiniteNumber(gc.temperature) || gc.temperature < 0 || gc.temperature > 2) {
        return {
          valid: false,
          error: "'generationConfig.temperature' must be a number between 0 and 2",
        };
      }
    }
    if (gc.topP !== undefined) {
      if (!isFiniteNumber(gc.topP) || gc.topP < 0 || gc.topP > 1) {
        return {
          valid: false,
          error: "'generationConfig.topP' must be a number between 0 and 1",
        };
      }
    }
    if (gc.topK !== undefined) {
      if (!isFiniteNumber(gc.topK) || gc.topK < 0) {
        return {
          valid: false,
          error: "'generationConfig.topK' must be a non-negative number",
        };
      }
    }
    if (gc.candidateCount !== undefined) {
      if (!Number.isInteger(gc.candidateCount) || (gc.candidateCount as number) < 1) {
        return {
          valid: false,
          error: "'generationConfig.candidateCount' must be a positive integer",
        };
      }
    }
    if (gc.maxOutputTokens !== undefined) {
      if (
        !Number.isInteger(gc.maxOutputTokens) ||
        (gc.maxOutputTokens as number) < 1
      ) {
        return {
          valid: false,
          error: "'generationConfig.maxOutputTokens' must be a positive integer",
        };
      }
    }
    if (gc.stopSequences !== undefined) {
      if (
        !Array.isArray(gc.stopSequences) ||
        gc.stopSequences.some((s) => typeof s !== "string")
      ) {
        return {
          valid: false,
          error: "'generationConfig.stopSequences' must be an array of strings",
        };
      }
    }
    for (const penalty of ["presencePenalty", "frequencyPenalty"] as const) {
      if (gc[penalty] !== undefined) {
        if (!isFiniteNumber(gc[penalty])) {
          return {
            valid: false,
            error: `'generationConfig.${penalty}' must be a number`,
          };
        }
      }
    }
    if (gc.responseMimeType !== undefined && typeof gc.responseMimeType !== "string") {
      return {
        valid: false,
        error: "'generationConfig.responseMimeType' must be a string",
      };
    }
    if (gc.responseSchema !== undefined && !isPlainObject(gc.responseSchema)) {
      return {
        valid: false,
        error: "'generationConfig.responseSchema' must be an object",
      };
    }
    if (gc.thinkingConfig !== undefined && !isPlainObject(gc.thinkingConfig)) {
      return {
        valid: false,
        error: "'generationConfig.thinkingConfig' must be an object",
      };
    }
  }

  if (req.tools !== undefined) {
    if (!Array.isArray(req.tools)) {
      return { valid: false, error: "'tools' must be an array" };
    }
    for (let i = 0; i < req.tools.length; i++) {
      const tool = req.tools[i];
      if (!isPlainObject(tool)) {
        return { valid: false, error: `tools[${i}] must be an object` };
      }
      if (tool.functionDeclarations !== undefined) {
        if (!Array.isArray(tool.functionDeclarations)) {
          return {
            valid: false,
            error: `tools[${i}].functionDeclarations must be an array`,
          };
        }
        for (let j = 0; j < tool.functionDeclarations.length; j++) {
          const decl = tool.functionDeclarations[j];
          if (!isPlainObject(decl)) {
            return {
              valid: false,
              error: `tools[${i}].functionDeclarations[${j}] must be an object`,
            };
          }
          if (!decl.name || typeof decl.name !== "string") {
            return {
              valid: false,
              error: `tools[${i}].functionDeclarations[${j}].name is required`,
            };
          }
          if (decl.parameters !== undefined && !isPlainObject(decl.parameters)) {
            return {
              valid: false,
              error: `tools[${i}].functionDeclarations[${j}].parameters must be an object`,
            };
          }
        }
      }
    }
  }

  if (req.toolConfig !== undefined) {
    if (!isPlainObject(req.toolConfig)) {
      return { valid: false, error: "'toolConfig' must be an object" };
    }
    const fcc = req.toolConfig.functionCallingConfig;
    if (fcc !== undefined) {
      if (!isPlainObject(fcc)) {
        return {
          valid: false,
          error: "'toolConfig.functionCallingConfig' must be an object",
        };
      }
      if (fcc.mode !== undefined && typeof fcc.mode !== "string") {
        return {
          valid: false,
          error: "'toolConfig.functionCallingConfig.mode' must be a string",
        };
      }
      if (fcc.allowedFunctionNames !== undefined) {
        if (
          !Array.isArray(fcc.allowedFunctionNames) ||
          fcc.allowedFunctionNames.some((n) => typeof n !== "string")
        ) {
          return {
            valid: false,
            error:
              "'toolConfig.functionCallingConfig.allowedFunctionNames' must be an array of strings",
          };
        }
      }
    }
  }

  if (req.safetySettings !== undefined) {
    if (
      !Array.isArray(req.safetySettings) ||
      req.safetySettings.some((setting) => !isPlainObject(setting))
    ) {
      return {
        valid: false,
        error: "'safetySettings' must be an array of objects",
      };
    }
  }

  if (req.stream !== undefined && typeof req.stream !== "boolean") {
    return { valid: false, error: "'stream' must be a boolean" };
  }

  return { valid: true };
}
