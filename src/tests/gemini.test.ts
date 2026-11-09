import test from "node:test";
import assert from "node:assert";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import {
  createGeminiStreamState,
  finalizeGeminiStream,
  mapFinishReason,
  mapGeminiModel,
  translateGeminiToOpenAI,
  translateOpenAIToGemini,
  translateStreamChunk,
} from "../routes/gemini/translate.ts";
import { validateGeminiRequest } from "../routes/gemini/validation.ts";
import { extractProvidedApiKeys } from "../core/auth-identity.ts";
import type { GeminiRequest } from "../routes/gemini/types.ts";

test("Gemini: mapGeminiModel aliases Gemini tiers and preserves suffixes", () => {
  assert.equal(mapGeminiModel("qwen3.8-max"), "qwen3.8-max");
  assert.equal(mapGeminiModel("models/qwen3.7-plus"), "qwen3.7-plus");

  assert.equal(mapGeminiModel("gemini-2.5-pro"), "qwen3.8-max");
  assert.equal(mapGeminiModel("gemini-1.5-pro-latest"), "qwen3.8-max");
  assert.equal(mapGeminiModel("gemini-2.5-flash"), "qwen3.7-plus");
  assert.equal(mapGeminiModel("gemini-2.5-flash-lite"), "qwen3.7-plus");

  assert.equal(mapGeminiModel("gemini-2.5-pro-fast"), "qwen3.8-max-fast");
  assert.equal(
    mapGeminiModel("gemini-2.5-flash-thinking"),
    "qwen3.7-plus-thinking",
  );
  assert.equal(
    mapGeminiModel("gemini-2.5-pro-search"),
    "qwen3.8-max-search",
  );
  assert.equal(mapGeminiModel("qwen3.8-max-fast"), "qwen3.8-max-fast");
});

test("Gemini: extractProvidedApiKeys accepts x-goog-api-key and ?key=", () => {
  const keys = extractProvidedApiKeys({
    authorization: "Bearer bearer-key",
    apiKey: "x-api-key-value",
    googApiKey: "goog-key",
    queryKey: "query-key",
  });
  assert.deepEqual(keys, [
    "bearer-key",
    "x-api-key-value",
    "goog-key",
    "query-key",
  ]);
});

test("Gemini: validateGeminiRequest validates structure", () => {
  assert.equal(
    validateGeminiRequest({
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    }).valid,
    true,
  );

  assert.equal(validateGeminiRequest({}).valid, false);
  assert.equal(validateGeminiRequest({ contents: [] }).valid, false);
  assert.equal(
    validateGeminiRequest({ contents: [{ parts: [] }] }).valid,
    false,
  );
  assert.equal(
    validateGeminiRequest({ contents: [{ parts: [{ text: 42 }] }] }).valid,
    false,
  );
  assert.equal(
    validateGeminiRequest({
      contents: [{ parts: [{ text: "hi" }] }],
      generationConfig: { temperature: 3 },
    }).valid,
    false,
  );
  assert.equal(
    validateGeminiRequest({
      contents: [{ parts: [{ text: "hi" }] }],
      generationConfig: { maxOutputTokens: 0 },
    }).valid,
    false,
  );
  assert.equal(
    validateGeminiRequest({
      contents: [{ parts: [{ text: "hi" }] }],
      tools: [{ functionDeclarations: [{ description: "missing name" }] }],
    }).valid,
    false,
  );
});

test("Gemini: translates system instruction and multi-turn contents", () => {
  const body: GeminiRequest = {
    systemInstruction: { parts: [{ text: "You are helpful." }] },
    contents: [
      { role: "user", parts: [{ text: "What is 2+2?" }] },
      { role: "model", parts: [{ text: "It is 4." }] },
      { role: "user", parts: [{ text: "Thanks" }] },
    ],
  };

  const { request, warnings } = translateGeminiToOpenAI(body, "gemini-2.5-pro");

  assert.equal(request.model, "qwen3.8-max");
  assert.equal(warnings.length, 0);
  assert.deepEqual(request.messages, [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "What is 2+2?" },
    { role: "assistant", content: "It is 4." },
    { role: "user", content: "Thanks" },
  ]);
});

test("Gemini: translates inlineData and fileData into uploadable parts", () => {
  const body: GeminiRequest = {
    contents: [
      {
        role: "user",
        parts: [
          { text: "Describe these" },
          {
            inlineData: {
              mimeType: "image/png",
              data: "iVBORw0KGgo=",
            },
          },
          {
            fileData: {
              mimeType: "application/pdf",
              fileUri: "https://example.com/report.pdf",
            },
          },
        ],
      },
    ],
  };

  const { request } = translateGeminiToOpenAI(body, "gemini-2.5-pro");
  const content = request.messages[0].content;
  assert.ok(Array.isArray(content));
  assert.deepEqual(content![0], { type: "text", text: "Describe these" });
  assert.deepEqual(content![1], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
  });
  assert.deepEqual(content![2], {
    type: "file_url",
    file_url: { url: "https://example.com/report.pdf" },
  });
});

test("Gemini: translates functionDeclarations and functionCallingConfig", () => {
  const body: GeminiRequest = {
    contents: [{ role: "user", parts: [{ text: "Run git status" }] }],
    tools: [
      {
        functionDeclarations: [
          {
            name: "Bash",
            description: "Run a shell command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        ],
      },
    ],
    toolConfig: {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: ["Bash"],
      },
    },
  };

  const { request } = translateGeminiToOpenAI(body, "gemini-2.5-pro");

  assert.equal(request.tools?.length, 1);
  assert.equal(request.tools![0].type, "function");
  assert.equal(request.tools![0].function.name, "Bash");
  assert.deepEqual(request.tools![0].function.parameters, {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  });
  assert.deepEqual(request.tool_choice, {
    type: "function",
    function: { name: "Bash" },
  });
});

test("Gemini: maps functionCall history and functionResponse round trips", () => {
  const body: GeminiRequest = {
    contents: [
      { role: "user", parts: [{ text: "Check git status" }] },
      {
        role: "model",
        parts: [
          { text: "Checking now." },
          { functionCall: { name: "Bash", args: { command: "git status" } } },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "Bash",
              response: { result: "working tree clean" },
            },
          },
          { text: "Now what?" },
        ],
      },
    ],
  };

  const { request } = translateGeminiToOpenAI(body, "gemini-2.5-pro");

  assert.equal(request.messages[0].role, "user");
  assert.equal(request.messages[1].role, "assistant");
  assert.equal(request.messages[1].content, "Checking now.");
  const call = request.messages[1].tool_calls![0];
  assert.equal(call.function.name, "Bash");
  assert.equal(call.function.arguments, '{"command":"git status"}');

  assert.equal(request.messages[2].role, "tool");
  assert.equal(request.messages[2].tool_call_id, call.id);
  assert.equal(request.messages[2].name, "Bash");
  assert.equal(request.messages[2].content, "working tree clean");

  assert.equal(request.messages[3].role, "user");
  assert.equal(request.messages[3].content, "Now what?");
});

test("Gemini: generationConfig maps sampling, budget, stop and JSON mode", () => {
  const body: GeminiRequest = {
    contents: [{ role: "user", parts: [{ text: "Return JSON" }] }],
    generationConfig: {
      temperature: 0.4,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 512,
      stopSequences: ["STOP"],
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
      },
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const { request, warnings } = translateGeminiToOpenAI(
    body,
    "gemini-2.5-pro",
  );

  assert.equal(request.temperature, 0.4);
  assert.equal(request.top_p, 0.9);
  assert.equal(request.top_k, 40);
  assert.equal(request.max_tokens, 512);
  assert.equal(request.max_completion_tokens, 512);
  assert.deepEqual(request.stop, ["STOP"]);
  assert.equal(request.reasoning_effort, "none");
  assert.deepEqual(request.response_format, {
    type: "json_schema",
    json_schema: {
      name: "gemini_response",
      strict: true,
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
      },
    },
  });

  const fields = warnings.map((warning) => warning.field);
  assert.ok(fields.includes("generationConfig.topK"));
});

test("Gemini: unsupported fields produce observable warnings", () => {
  const body: GeminiRequest = {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    safetySettings: [
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
    ],
    tools: [{ googleSearch: {} }],
    generationConfig: { candidateCount: 2, seed: 7 },
    cachedContent: "cachedContents/abc",
    stream: true,
  };

  const { request, warnings } = translateGeminiToOpenAI(
    body,
    "gemini-2.5-pro",
  );
  const fields = warnings.map((warning) => warning.field);

  assert.ok(fields.includes("safetySettings"));
  assert.ok(fields.includes("tools[0].googleSearch"));
  assert.ok(fields.includes("generationConfig.candidateCount"));
  assert.ok(fields.includes("generationConfig.seed"));
  assert.ok(fields.includes("cachedContent"));
  assert.ok(fields.includes("stream"));
  assert.equal(request.n, 1);
});

test("Gemini: translates a non-streaming completion into candidates and usage", () => {
  const response = {
    id: "chatcmpl-gemini",
    model: "qwen3.8-max",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Hello from Qwen",
          reasoning_content: "Considering the request",
          tool_calls: [
            {
              id: "call_1",
              type: "function" as const,
              function: {
                name: "Bash",
                arguments: '{"command":"ls"}',
              },
            },
          ],
        },
        finish_reason: "tool_calls" as const,
      },
    ],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 7,
      total_tokens: 19,
      completion_tokens_details: { reasoning_tokens: 3 },
    },
  };

  const result = translateOpenAIToGemini(response, "gemini-2.5-pro");

  assert.equal(result.modelVersion, "gemini-2.5-pro");
  const parts = result.candidates[0].content.parts;
  assert.deepEqual(parts[0], {
    text: "Considering the request",
    thought: true,
  });
  assert.deepEqual(parts[1], { text: "Hello from Qwen" });
  assert.deepEqual(parts[2], {
    functionCall: { name: "Bash", args: { command: "ls" } },
  });
  assert.equal(result.candidates[0].finishReason, "STOP");
  assert.deepEqual(result.usageMetadata, {
    promptTokenCount: 12,
    candidatesTokenCount: 7,
    totalTokenCount: 19,
    thoughtsTokenCount: 3,
  });
});

test("Gemini: non-streaming output obeys maxOutputTokens", () => {
  const response = {
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "word ".repeat(200),
        },
        finish_reason: "stop" as const,
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 200, total_tokens: 205 },
  };

  const result = translateOpenAIToGemini(response, "gemini-2.5-pro", {
    maxOutputTokens: 10,
  });

  assert.equal(result.candidates[0].finishReason, "MAX_TOKENS");
  const text = result.candidates[0].content.parts[0].text || "";
  assert.ok(text.length > 0);
  assert.ok(text.length < "word ".repeat(200).length);
  // Usage must describe the truncated candidate, not the upstream total.
  assert.ok(result.usageMetadata!.candidatesTokenCount! <= 11);
  assert.equal(
    result.usageMetadata!.totalTokenCount,
    result.usageMetadata!.promptTokenCount +
      result.usageMetadata!.candidatesTokenCount!,
  );
});

test("Gemini: upstream length stop reports emitted usage, not pre-truncation totals", () => {
  const response = {
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Short answer",
          reasoning_content: "A long chain of thought",
        },
        finish_reason: "length" as const,
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 4000,
      total_tokens: 4010,
      completion_tokens_details: { reasoning_tokens: 50 },
    },
  };

  const result = translateOpenAIToGemini(response, "gemini-2.5-pro", {
    maxOutputTokens: 20,
  });

  assert.equal(result.candidates[0].finishReason, "MAX_TOKENS");
  assert.ok(result.usageMetadata!.candidatesTokenCount! < 100);
  assert.equal(
    result.usageMetadata!.totalTokenCount,
    result.usageMetadata!.promptTokenCount +
      result.usageMetadata!.candidatesTokenCount!,
  );
});

test("Gemini: mapFinishReason covers stop, length, safety and tools", () => {
  assert.equal(mapFinishReason("stop", false, false), "STOP");
  assert.equal(mapFinishReason("tool_calls", true, false), "STOP");
  assert.equal(mapFinishReason("length", false, false), "MAX_TOKENS");
  assert.equal(mapFinishReason("content_filter", false, false), "SAFETY");
  assert.equal(mapFinishReason("stop", false, true), "MAX_TOKENS");
});

test("Gemini: stream translation emits text and thought parts incrementally", () => {
  const state = createGeminiStreamState("gemini-2.5-pro");

  const thought = translateStreamChunk(
    {
      choices: [
        { index: 0, delta: { reasoning_content: "Thinking..." } },
      ],
    },
    state,
  );
  assert.equal(thought.length, 1);
  assert.deepEqual(thought[0].candidates[0].content.parts, [
    { text: "Thinking...", thought: true },
  ]);

  const text = translateStreamChunk(
    { choices: [{ index: 0, delta: { content: "Hello" } }] },
    state,
  );
  assert.equal(text.length, 1);
  assert.deepEqual(text[0].candidates[0].content.parts, [
    { text: "Hello" },
  ]);

  const usage = translateStreamChunk(
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
      },
    },
    state,
  );
  assert.equal(usage.length, 0, "finish emits only through finalize");

  const final = finalizeGeminiStream(state);
  assert.equal(final.candidates[0].finishReason, "STOP");
  assert.deepEqual(final.usageMetadata, {
    promptTokenCount: 3,
    candidatesTokenCount: 2,
    totalTokenCount: 5,
  });
  assert.equal(state.terminalEmitted, true);
});

test("Gemini: stream translation accumulates tool call deltas exactly once", () => {
  const state = createGeminiStreamState("gemini-2.5-pro");

  translateStreamChunk(
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_abc",
                function: { name: "Bash", arguments: '{"command":' },
              },
            ],
          },
        },
      ],
    },
    state,
  );
  translateStreamChunk(
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: '"ls"}' },
              },
            ],
          },
        },
      ],
    },
    state,
  );
  translateStreamChunk(
    {
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
    state,
  );

  const final = finalizeGeminiStream(state);
  assert.deepEqual(final.candidates[0].content.parts, [
    { functionCall: { name: "Bash", args: { command: "ls" } } },
  ]);
  assert.equal(final.candidates[0].finishReason, "STOP");

  // Calling finalize again would create a second terminal event, so the route
  // guards on terminalEmitted. Assert the state flag is set.
  assert.equal(state.terminalEmitted, true);
});

test("Gemini: streaming output obeys maxOutputTokens", () => {
  const state = createGeminiStreamState("gemini-2.5-pro", 5);

  for (let i = 0; i < 40; i++) {
    translateStreamChunk(
      {
        choices: [
          { index: 0, delta: { content: "token " } },
        ],
      },
      state,
    );
  }

  assert.equal(state.budgetExceeded, true);
  assert.ok(state.text.length > 0);
  const final = finalizeGeminiStream(state);
  assert.equal(final.candidates[0].finishReason, "MAX_TOKENS");
  assert.ok(final.usageMetadata!.candidatesTokenCount! > 0);
  assert.equal(
    final.usageMetadata!.totalTokenCount,
    final.usageMetadata!.promptTokenCount +
      final.usageMetadata!.candidatesTokenCount!,
  );
});

test("Gemini: translates an empty candidate as an explicit OTHER finish", () => {
  const result = translateOpenAIToGemini({}, "gemini-2.5-pro");
  assert.equal(result.candidates[0].finishReason, "OTHER");
  assert.deepEqual(result.candidates[0].content.parts, []);
  assert.deepEqual(result.usageMetadata, {
    promptTokenCount: 0,
    candidatesTokenCount: 0,
    totalTokenCount: 0,
  });
});
