import type { Context } from "hono";
import {
  DEFAULT_IMAGE_EDIT_MODEL,
  generateImage,
  isSupportedMediaSize,
  listMediaGenerationModels,
  MEDIA_SIZE_OPTIONS,
  supportsImageEditing,
  supportsPromptMediaGeneration,
} from "../services/media-generation.ts";
import { logger } from "../core/logger.ts";
import { sendOpenAIError } from "../api/error-helpers.ts";
import { ValidationError } from "../core/errors.ts";
import {
  assertSafeRemoteMediaUrl,
  readResponseWithByteCap,
} from "../core/safe-remote-url.ts";

const DEFAULT_SIZE = "auto";
const MAX_EDIT_IMAGE_BYTES = 20 * 1024 * 1024;
const EDIT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
const EDIT_IMAGE_MIME_SET: ReadonlySet<string> = new Set(EDIT_IMAGE_MIME_TYPES);

interface ImageDataItem {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

interface ImagesGenerationsRequest {
  model?: unknown;
  prompt?: unknown;
  n?: unknown;
  size?: unknown;
  /** Accepted for OpenAI compatibility but ignored — Qwen has no quality parameter. */
  quality?: unknown;
  response_format?: unknown;
}

function validationError(message: string, param: string): ValidationError {
  const err = new ValidationError(message);
  err.param = param;
  return err;
}

async function urlToBase64(url: string): Promise<string> {
  await assertSafeRemoteMediaUrl(url);
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) {
    throw new Error(`Failed to download generated image: HTTP ${response.status}`);
  }
  const buffer = await readResponseWithByteCap(response, MAX_EDIT_IMAGE_BYTES);
  return buffer.toString("base64");
}

function sniffImageMime(buffer: Buffer): string | null {
  if (
    buffer.length >= 8 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (buffer.length >= 6) {
    const head = buffer.subarray(0, 6).toString("ascii");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function extensionForMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}

function sanitizeEditFilename(name: string, mime: string): string {
  const base = (name || "").split(/[\\/]/).pop()?.trim() || "";
  const cleaned = base.replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  return cleaned || `image-edit.${extensionForMime(mime)}`;
}

function readFormString(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" ? value : undefined;
}

export async function imagesGenerations(c: Context): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return sendOpenAIError(c, new ValidationError("Request body must be valid JSON"));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return sendOpenAIError(
      c,
      new ValidationError("Request body must be a JSON object"),
    );
  }
  const body = parsed as ImagesGenerationsRequest;

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return sendOpenAIError(
      c,
      validationError("`prompt` must be a non-empty string", "prompt"),
    );
  }

  // Cap `n` like the edits route: each unit fans out to one upstream image
  // request, so an unbounded value is a resource amplifier for any caller.
  const n = body.n === undefined ? 1 : body.n;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 10) {
    return sendOpenAIError(
      c,
      validationError("`n` must be an integer between 1 and 10", "n"),
    );
  }

  const size = body.size === undefined ? DEFAULT_SIZE : body.size;
  if (!isSupportedMediaSize(size)) {
    return sendOpenAIError(
      c,
      validationError(
        `\`size\` must be one of: ${MEDIA_SIZE_OPTIONS.join(", ")}`,
        "size",
      ),
    );
  }

  const responseFormat = body.response_format ?? "url";
  if (responseFormat !== "url" && responseFormat !== "b64_json") {
    return sendOpenAIError(
      c,
      validationError('`response_format` must be "url" or "b64_json"', "response_format"),
    );
  }

  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : "";
  if (!model) {
    return sendOpenAIError(
      c,
      validationError("`model` must be the model selected by the client", "model"),
    );
  }
  if (!supportsPromptMediaGeneration(model, "image")) {
    return sendOpenAIError(
      c,
      validationError(
        `Model \`${model}\` requires a reference image and is not available through prompt-only image generation yet`,
        "model",
      ),
    );
  }

  logger.info("Image generation request", {
    model,
    n,
    size,
    response_format: responseFormat,
  });

  try {
    const results = await Promise.all(
      Array.from({ length: n }, () => generateImage({ model, prompt, size })),
    );

    const data: ImageDataItem[] = await Promise.all(
      results.map(async (result): Promise<ImageDataItem> => {
        const item: ImageDataItem =
          responseFormat === "b64_json"
            ? { b64_json: await urlToBase64(result.url) }
            : { url: result.url };
        if (result.revised_prompt) {
          item.revised_prompt = result.revised_prompt;
        }
        return item;
      }),
    );

    logger.info("Image generation completed", { model, n });
    return c.json({ created: Math.floor(Date.now() / 1000), data });
  } catch (error) {
    logger.error("Image generation failed", {
      model,
      error: error instanceof Error ? error.message : String(error),
    });
    return sendOpenAIError(c, error, 500);
  }
}

/**
 * POST /v1/images/edits — OpenAI-compatible image editing.
 *
 * Accepts multipart form data with `image` and `prompt`; the image is uploaded
 * through the existing Qwen OSS path and attached to an `image_edit` chat.
 * Masks are not supported by the Qwen backend and are rejected explicitly.
 */
export async function imagesEdits(c: Context): Promise<Response> {
  const contentType = (c.req.header("content-type") || "").toLowerCase();
  if (!contentType.includes("multipart/form-data")) {
    return sendOpenAIError(
      c,
      validationError(
        "Request body must be multipart/form-data with `image` and `prompt`",
        "image",
      ),
    );
  }

  // Reject oversized multipart bodies before buffering them in memory.
  const contentLength = Number(c.req.header("content-length") || "0");
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_EDIT_IMAGE_BYTES + 1024 * 1024
  ) {
    return sendOpenAIError(
      c,
      validationError(
        "`image` exceeds the 20MB upload limit",
        "image",
      ),
    );
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return sendOpenAIError(
      c,
      new ValidationError("Request body must be valid multipart/form-data"),
    );
  }

  const prompt = (readFormString(form, "prompt") ?? "").trim();
  if (!prompt) {
    return sendOpenAIError(
      c,
      validationError("`prompt` must be a non-empty string", "prompt"),
    );
  }

  const mask = form.get("mask");
  if (mask) {
    return sendOpenAIError(
      c,
      validationError(
        "`mask` is not supported by the Qwen image edit backend; provide only the base `image`",
        "mask",
      ),
    );
  }

  const image = form.get("image");
  if (!(image instanceof File)) {
    return sendOpenAIError(
      c,
      validationError("`image` must be a file upload", "image"),
    );
  }
  if (image.size === 0) {
    return sendOpenAIError(
      c,
      validationError("`image` must not be empty", "image"),
    );
  }
  if (image.size > MAX_EDIT_IMAGE_BYTES) {
    return sendOpenAIError(
      c,
      validationError(
        `\`image\` exceeds the 20MB upload limit (${image.size} bytes)`,
        "image",
      ),
    );
  }

  const nValue = readFormString(form, "n");
  let n = 1;
  if (nValue !== undefined && nValue.trim() !== "") {
    n = Number(nValue);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      return sendOpenAIError(
        c,
        validationError("`n` must be an integer between 1 and 10", "n"),
      );
    }
  }

  const size = readFormString(form, "size")?.trim();
  if (size && !isSupportedMediaSize(size)) {
    return sendOpenAIError(
      c,
      validationError(
        `\`size\` must be one of: ${MEDIA_SIZE_OPTIONS.join(", ")}`,
        "size",
      ),
    );
  }

  const responseFormat = readFormString(form, "response_format")?.trim() || "url";
  if (responseFormat !== "url" && responseFormat !== "b64_json") {
    return sendOpenAIError(
      c,
      validationError(
        '`response_format` must be "url" or "b64_json"',
        "response_format",
      ),
    );
  }

  const requestedModel = readFormString(form, "model")?.trim();
  const model = requestedModel || DEFAULT_IMAGE_EDIT_MODEL;
  if (!supportsImageEditing(model)) {
    const editModels = listMediaGenerationModels()
      .filter(({ kind, modes }) => kind === "image" && modes.includes("i2i"))
      .map(({ id }) => id);
    return sendOpenAIError(
      c,
      validationError(
        `Model \`${model}\` does not support image editing; use one of: ${editModels.join(", ")}`,
        "model",
      ),
    );
  }

  const buffer = Buffer.from(await image.arrayBuffer());
  const declaredMime = (image.type || "").split(";")[0].trim().toLowerCase();
  const sniffedMime = sniffImageMime(buffer);
  const mime =
    sniffedMime && EDIT_IMAGE_MIME_SET.has(sniffedMime)
      ? sniffedMime
      : declaredMime;
  if (!EDIT_IMAGE_MIME_SET.has(mime)) {
    return sendOpenAIError(
      c,
      validationError(
        `Unsupported image type: ${image.type || "unknown"}. Supported: ${EDIT_IMAGE_MIME_TYPES.join(", ")}`,
        "image",
      ),
    );
  }

  const filename = sanitizeEditFilename(image.name, mime);

  logger.info("Image edit request", {
    model,
    n,
    size: size || "auto",
    response_format: responseFormat,
    input_mime: mime,
    input_bytes: buffer.length,
  });

  try {
    const results = await Promise.all(
      Array.from({ length: n }, () =>
        generateImage({
          model,
          prompt,
          size,
          edit: { buffer, filename, mime },
        }),
      ),
    );

    const data: ImageDataItem[] = await Promise.all(
      results.map(async (result): Promise<ImageDataItem> => {
        const item: ImageDataItem =
          responseFormat === "b64_json"
            ? { b64_json: await urlToBase64(result.url) }
            : { url: result.url };
        if (result.revised_prompt) {
          item.revised_prompt = result.revised_prompt;
        }
        return item;
      }),
    );

    logger.info("Image edit completed", { model, n });
    return c.json({ created: Math.floor(Date.now() / 1000), data });
  } catch (error) {
    logger.error("Image edit failed", {
      model,
      error: error instanceof Error ? error.message : String(error),
    });
    return sendOpenAIError(c, error);
  }
}
