import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.API_KEY = "";

import { app } from "../api/server.ts";
import { config } from "../core/config.ts";
import { ContentPolicyError } from "../core/errors.ts";
import {
  DEFAULT_IMAGE_EDIT_MODEL,
  detectMediaContentPolicyError,
  generateImage,
  supportsImageEditing,
} from "../services/media-generation.ts";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

const COMPLETIONS_SSE =
  'data: {"choices":[{"delta":{"content":"https://cdn.example.com/edited.png"}}]}\n\n' +
  "data: [DONE]\n";

interface CapturedRequests {
  sts?: Record<string, unknown>;
  chatCreation?: Record<string, unknown>;
  completions?: Record<string, any>;
}

function installMockFetch(options: { completionsBody?: string } = {}): {
  captured: CapturedRequests;
  restore: () => void;
} {
  const originalFetch = globalThis.fetch;
  const captured: CapturedRequests = {};

  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;

    if (url.includes("/api/v2/files/getstsToken")) {
      captured.sts = JSON.parse(String(init?.body || "{}"));
      return new Response(
        JSON.stringify({
          success: true,
          request_id: "req-edit",
          data: {
            access_key_id: "ak",
            access_key_secret: "sk",
            security_token: "token",
            file_url: "https://oss.example/input.png?signature=1",
            file_path: "uploads/input.png",
            file_id: "file-edit-1",
            bucketname: "bucket",
            region: "oss-region",
            endpoint: "oss.example",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.includes("/api/v2/chats/new")) {
      captured.chatCreation = JSON.parse(String(init?.body || "{}"));
      return new Response(
        JSON.stringify({ success: true, data: { id: "chat-edit-1" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.includes("/api/v2/chat/completions")) {
      captured.completions = JSON.parse(String(init?.body || "{}"));
      return new Response(options.completionsBody ?? COMPLETIONS_SSE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }

    return originalFetch(input, init);
  };

  return {
    captured,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function withNodeTransport<T>(fn: () => Promise<T>): Promise<T> {
  const previous = config.qwen.browserOnlyFetch;
  config.qwen.browserOnlyFetch = false;
  return fn().finally(() => {
    config.qwen.browserOnlyFetch = previous;
  });
}

function imageEditRequest(
  fields: Record<string, string>,
  image?: File,
): Promise<Response> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value);
  }
  if (image) form.set("image", image);
  return Promise.resolve(
    app.fetch(
      new Request("http://localhost/v1/images/edits", {
        method: "POST",
        body: form,
      }),
    ),
  );
}

test("Image edit capabilities: only i2i models are accepted, default is explicit", () => {
  assert.equal(DEFAULT_IMAGE_EDIT_MODEL, "qwen-image-3.0-pro");
  assert.equal(supportsImageEditing(DEFAULT_IMAGE_EDIT_MODEL), true);
  assert.equal(supportsImageEditing("qwen-image-3.0"), true);
  assert.equal(supportsImageEditing("wan2.7-image-pro"), true);
  assert.equal(supportsImageEditing("z-image-turbo"), false);
  assert.equal(supportsImageEditing("wan3.0-video"), false);
  assert.equal(supportsImageEditing("wan2.7-i2v"), false);
  // Unknown models are forwarded as chat models, matching generation behavior.
  assert.equal(supportsImageEditing("qwen3.7-plus"), true);
});

test("Image edit policy detection recognizes JSON and SSE moderation errors", () => {
  assert.equal(detectMediaContentPolicyError("not json at all"), null);
  assert.equal(
    detectMediaContentPolicyError(
      JSON.stringify({ success: false, data: { code: "RateLimited", num: 4 } }),
    ),
    null,
  );
  assert.match(
    detectMediaContentPolicyError(
      JSON.stringify({
        success: false,
        data: {
          code: "DataInspectionFailed",
          details: "Input image contains sensitive content",
        },
      }),
    ) ?? "",
    /sensitive/,
  );
  assert.match(
    detectMediaContentPolicyError(
      'data: {"success":false,"data":{"code":"DataInspectionFailed","message":"image violates content policy"}}\n\ndata: [DONE]\n',
    ) ?? "",
    /content policy/,
  );
});

test("Images Edits Route: validates multipart input and OpenAI parameters", async () => {
  let res = await app.fetch(
    new Request("http://localhost/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "make it blue" }),
    }),
  );
  assert.equal(res.status, 400);
  let json = (await res.json()) as any;
  assert.match(json.error.message, /multipart\/form-data/);

  res = await imageEditRequest(
    {},
    new File([PNG_BYTES], "input.png", { type: "image/png" }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.match(json.error.message, /prompt/);

  res = await imageEditRequest({ prompt: "make it blue" });
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.match(json.error.message, /image/);

  res = await imageEditRequest(
    { prompt: "make it blue" },
    new File([PNG_BYTES], "input.png", { type: "image/png" }),
  );
  // No accounts are seeded for this test process; validation passed and the
  // request failed later at account selection rather than returning a 400.
  assert.notEqual(res.status, 400);

  res = await imageEditRequest(
    { prompt: "make it blue", mask: "mask" },
    new File([PNG_BYTES], "input.png", { type: "image/png" }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.match(json.error.message, /mask/);

  res = await imageEditRequest(
    { prompt: "make it blue", n: "0" },
    new File([PNG_BYTES], "input.png", { type: "image/png" }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.match(json.error.message, /`n`/);

  res = await imageEditRequest(
    { prompt: "make it blue", size: "999x999" },
    new File([PNG_BYTES], "input.png", { type: "image/png" }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.match(json.error.message, /`size`/);

  res = await imageEditRequest(
    { prompt: "make it blue", response_format: "raw_buffer" },
    new File([PNG_BYTES], "input.png", { type: "image/png" }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.match(json.error.message, /response_format/);

  res = await imageEditRequest(
    { prompt: "make it blue", model: "z-image-turbo" },
    new File([PNG_BYTES], "input.png", { type: "image/png" }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.match(json.error.message, /does not support image editing/);

  res = await imageEditRequest(
    { prompt: "make it blue" },
    new File([Buffer.from("not an image")], "input.txt", {
      type: "text/plain",
    }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.match(json.error.message, /Unsupported image type/);

  res = await imageEditRequest(
    { prompt: "make it blue" },
    new File([Buffer.alloc(20 * 1024 * 1024 + 1)], "big.png", {
      type: "image/png",
    }),
  );
  assert.equal(res.status, 400);
  json = (await res.json()) as any;
  assert.match(json.error.message, /20MB/);
});

test("generateImage edit path uploads the image and sends image_edit upstream", async () => {
  const mock = installMockFetch();

  try {
    const result = await withNodeTransport(() =>
      generateImage({
        prompt: "make the background blue",
        model: "qwen-image-3.0-pro",
        size: "1024x1024",
        accountId: "account-edit",
        edit: {
          buffer: PNG_BYTES,
          filename: "input.png",
          mime: "image/png",
        },
      }),
    );

    assert.equal(result.url, "https://cdn.example.com/edited.png");
    assert.equal(result.chatId, "chat-edit-1");
    assert.equal(result.accountId, "account-edit");

    assert.ok(mock.captured.sts);
    assert.equal(mock.captured.sts?.filename, "input.png");
    assert.equal(mock.captured.sts?.filetype, "image");
    assert.equal(mock.captured.sts?.filesize, String(PNG_BYTES.length));

    assert.ok(mock.captured.chatCreation);
    assert.equal(mock.captured.chatCreation?.chat_type, "image_edit");

    const payload = mock.captured.completions;
    assert.ok(payload);
    assert.equal(payload.stream, true);
    assert.equal(payload.chat_id, "chat-edit-1");
    assert.equal(payload.messages[0].content, "make the background blue");
    assert.equal(payload.messages[0].chat_type, "image_edit");
    assert.equal(payload.messages[0].sub_chat_type, "image_edit");
    assert.equal(payload.messages[0].files.length, 1);
    assert.equal(payload.messages[0].files[0].type, "image");
    assert.equal(
      payload.messages[0].files[0].url,
      "https://oss.example/input.png",
    );
    assert.equal(payload.messages[0].extra.meta.model, "qwen-image-3.0-pro");
    // `size` is accepted for OpenAI compatibility but never sent for edits.
    assert.equal(payload.size, undefined);
    assert.equal(payload.messages[0].extra.meta.size, undefined);
  } finally {
    mock.restore();
  }
});

test("generateImage edit path maps upstream moderation to ContentPolicyError", async () => {
  const mock = installMockFetch({
    completionsBody:
      "data: [DONE]\n\n" +
      'data: {"success":false,"data":{"code":"DataInspectionFailed","message":"Input image violates the content policy"}}\n',
  });

  try {
    await assert.rejects(
      () =>
        withNodeTransport(() =>
          generateImage({
            prompt: "make the background blue",
            model: "qwen-image-3.0-pro",
            accountId: "account-edit",
            edit: {
              buffer: PNG_BYTES,
              filename: "input.png",
              mime: "image/png",
            },
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof ContentPolicyError);
        assert.equal(error.statusCode, 400);
        assert.equal(error.code, "content_policy_violation");
        assert.match(error.message, /content policy/);
        return true;
      },
    );
  } finally {
    mock.restore();
  }
});
