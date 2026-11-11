import test from "node:test";
import assert from "node:assert/strict";

process.env.TEST_MOCK_QWEN_AUTH = "true";
process.env.API_KEY = "";

import { app } from "../api/server.ts";
import {
  storeResponse,
  getResponseHistory,
  getStoredResponse,
  deleteStoredResponse,
  pruneExpiredResponses,
  RESPONSE_RETENTION_MS,
} from "../routes/responses/state.ts";
import {
  createStreamState,
  processChatChunk,
  buildFinalOutput,
  buildFinalUsage,
} from "../routes/responses/streaming.ts";
import {
  responsesToChatCompletions,
  chatCompletionsToResponses,
} from "../routes/responses/adapter.ts";
import { validateResponsesRequest } from "../routes/responses/validation.ts";
import { createUser } from "../core/users.ts";
import type { ResponsesResponse, ResponsesRequest } from "../routes/responses/types.ts";

function minimalResponse(id: string): ResponsesResponse {
  return {
    id,
    object: "response",
    created_at: 1700000000,
    model: "qwen3.7-plus",
    status: "completed",
    output: [],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

test("Responses State: storeResponse, getResponseHistory, getStoredResponse, and deleteStoredResponse", () => {
  const responseId = "resp_test_state_1";
  const mockResponse: ResponsesResponse = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: "qwen3.7-plus",
    status: "completed" as const,
    output: [
      {
        id: "msg_1",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello there!", annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };

  const chatMessages = [
    { role: "user" as const, content: "Hello" },
    { role: "assistant" as const, content: "Hello there!" },
  ];

  // 1. Store
  storeResponse(responseId, mockResponse, chatMessages);

  // 2. Retrieve history
  const history = getResponseHistory(responseId);
  assert.ok(history);
  assert.equal(history?.length, 2);
  assert.equal(history?.[0].content, "Hello");

  // 3. Retrieve stored response
  const stored = getStoredResponse(responseId);
  assert.ok(stored);
  assert.equal(stored?.id, responseId);
  assert.equal(stored?.status, "completed");

  // 4. Non-existent returns null
  assert.equal(getResponseHistory("resp_non_existent"), null);
  assert.equal(getStoredResponse("resp_non_existent"), null);

  // 5. Delete stored response
  const deleted = deleteStoredResponse(responseId);
  assert.equal(deleted, true);
  assert.equal(getResponseHistory(responseId), null);
  assert.equal(getStoredResponse(responseId), null);
});

test("Responses State: expired entries are pruned and fresh entries survive", () => {
  const freshId = "resp_test_prune_fresh";
  const staleId = "resp_test_prune_stale";
  const chat = [{ role: "user" as const, content: "hi" }];

  storeResponse(freshId, minimalResponse(freshId), chat);
  storeResponse(staleId, minimalResponse(staleId), chat);

  // A prune at the current time must not touch a just-written response.
  pruneExpiredResponses(Date.now());
  assert.ok(getStoredResponse(freshId));

  // A prune past the retention window drops both the cache entry and the row.
  const removed = pruneExpiredResponses(
    Date.now() + RESPONSE_RETENTION_MS + 1,
  );
  assert.ok(removed >= 2);
  assert.equal(getStoredResponse(freshId), null);
  assert.equal(getResponseHistory(freshId), null);
  assert.equal(getStoredResponse(staleId), null);
});

test("Responses Validation: validateResponsesRequest handles valid and invalid payloads", () => {
  // Invalid JSON object
  assert.equal(validateResponsesRequest(null).valid, false);
  assert.equal(validateResponsesRequest("string").valid, false);
  assert.equal(validateResponsesRequest([]).valid, false);

  // Missing model
  assert.equal(validateResponsesRequest({ input: "hi" }).valid, false);

  // Missing input
  assert.equal(validateResponsesRequest({ model: "qwen3.7-plus" }).valid, false);

  // Valid string input
  const validStr = validateResponsesRequest({
    model: "qwen3.7-plus",
    input: "Explain quantum physics",
    stream: true,
  });
  assert.equal(validStr.valid, true);
  assert.equal(validStr.data?.model, "qwen3.7-plus");
  assert.equal(validStr.data?.stream, true);

  // Valid array input with content parts
  const validArray = validateResponsesRequest({
    model: "qwen3.8-max",
    input: [
      { role: "user", content: "hello" },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Look at this image" },
          { type: "input_image", image_url: "https://example.com/img.png" },
          { type: "input_file", file_url: "https://example.com/doc.pdf" },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object" },
      },
    ],
  });
  assert.equal(validArray.valid, true);
  assert.equal(validArray.data?.tools?.length, 1);
});

test("Responses Adapter: responsesToChatCompletions converts input, reasoning, and tools", () => {
  const req: ResponsesRequest = {
    model: "qwen3.8-max",
    input: [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "What is 2+2?" },
    ],
    instructions: "Be brief and concise",
    reasoning: { effort: "high" },
    max_output_tokens: 100,
    temperature: 0.7,
    tools: [
      {
        type: "function",
        name: "calculate",
        description: "Calculator",
        parameters: { type: "object", properties: { expr: { type: "string" } } },
      },
    ],
  };

  const chatReq = responsesToChatCompletions(req);
  assert.equal(chatReq.model, "qwen3.8-max");
  assert.equal(chatReq.max_completion_tokens, 100);
  assert.equal(chatReq.temperature, 0.7);
  assert.equal(chatReq.reasoning_effort, "high");
  assert.equal(chatReq.tools?.length, 1);
  assert.equal(chatReq.tools?.[0].function.name, "calculate");

  // Verify instructions prepend to system messages
  assert.ok(chatReq.messages.some((m) => m.role === "system" && Boolean(m.content && m.content.includes("Be brief"))));
});

test("Responses State: owner-scoped lookups hide another tenant's response", () => {
  const id = `resp_owner_scope_${Math.random().toString(36).slice(2)}`;
  storeResponse(
    id,
    minimalResponse(id),
    [{ role: "user", content: "secret" }],
    "owner-a",
  );

  assert.ok(getStoredResponse(id, "owner-a"));
  assert.equal(getStoredResponse(id, "owner-b"), null);
  assert.deepEqual(getResponseHistory(id, "owner-a"), [
    { role: "user", content: "secret" },
  ]);
  assert.equal(getResponseHistory(id, "owner-b"), null);

  // A foreign delete must neither remove nor broadcast the row.
  assert.equal(deleteStoredResponse(id, "owner-b"), false);
  assert.ok(getStoredResponse(id, "owner-a"));

  assert.equal(deleteStoredResponse(id, "owner-a"), true);
  assert.equal(getStoredResponse(id, "owner-a"), null);
});

test("Responses HTTP: another API key cannot read, continue or delete a response", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = createUser(`resp-owner-${suffix}`, { role: "user" });
  const other = createUser(`resp-other-${suffix}`, { role: "user" });
  const id = `resp_tenant_${suffix}`;
  storeResponse(
    id,
    minimalResponse(id),
    [{ role: "user", content: "tenant secret" }],
    owner.user.id,
  );

  try {
    const otherHeaders = { "x-api-key": other.apiKey };

    let res = await app.fetch(
      new Request(`http://localhost/v1/responses/${id}`, {
        headers: otherHeaders,
      }),
    );
    assert.equal(res.status, 404);

    res = await app.fetch(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...otherHeaders,
        },
        body: JSON.stringify({
          model: "qwen3.7-plus",
          input: "follow up",
          previous_response_id: id,
        }),
      }),
    );
    assert.equal(res.status, 404);

    res = await app.fetch(
      new Request(`http://localhost/v1/responses/${id}`, {
        method: "DELETE",
        headers: otherHeaders,
      }),
    );
    assert.equal(res.status, 404);

    res = await app.fetch(
      new Request(`http://localhost/v1/responses/${id}`, {
        headers: { "x-api-key": owner.apiKey },
      }),
    );
    assert.equal(res.status, 200);
  } finally {
    deleteStoredResponse(id, owner.user.id);
  }
});

test("Responses Adapter: chatCompletionsToResponses maps assistant response and tool calls", () => {
  const chatResponse = {
    id: "chatcmpl-test-123",
    created: 1700000000,
    model: "qwen3.7-plus",
    object: "chat.completion" as const,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: "The weather in Tokyo is sunny.",
          tool_calls: [
            {
              id: "call_abc123",
              type: "function" as const,
              function: { name: "get_weather", arguments: '{"location":"Tokyo"}' },
            },
          ],
        },
        finish_reason: "tool_calls" as const,
      },
    ],
    usage: {
      prompt_tokens: 25,
      completion_tokens: 15,
      total_tokens: 40,
    },
  };

  const converted = chatCompletionsToResponses(chatResponse, "qwen3.7-plus", {
    input: "Weather in Tokyo",
    model: "qwen3.7-plus",
  });
  assert.ok(converted.id.startsWith("resp_"));
  assert.equal(converted.status, "completed");
  assert.equal(converted.output.length, 2); // 1 message + 1 function_call

  const msgItem = converted.output[0];
  assert.equal(msgItem.type, "message");
  if (msgItem.type === "message") {
    assert.equal(msgItem.content[0].text, "The weather in Tokyo is sunny.");
  }

  const fnItem = converted.output[1];
  assert.equal(fnItem.type, "function_call");
  if (fnItem.type === "function_call") {
    assert.equal(fnItem.name, "get_weather");
    assert.equal(fnItem.call_id, "call_abc123");
  }
});

test("Responses Adapter: chatCompletionsToResponses extracts reasoning_tokens from output_tokens_details", () => {
  const chatResponse = {
    id: "chatcmpl-test-reasoning",
    created: 1700000000,
    model: "qwen3.7-plus",
    object: "chat.completion" as const,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: "Result after thinking.",
        },
        finish_reason: "stop" as const,
      },
    ],
    usage: {
      prompt_tokens: 50,
      completion_tokens: 30,
      total_tokens: 80,
      output_tokens_details: {
        reasoning_tokens: 22,
      },
    },
  };

  const converted = chatCompletionsToResponses(chatResponse, "qwen3.7-plus", {
    input: "Thinking query",
    model: "qwen3.7-plus",
  });

  assert.ok(converted.usage);
  assert.equal(
    converted.usage.output_tokens_details.reasoning_tokens,
    22,
    "must extract reasoning_tokens from output_tokens_details when completion_tokens_details is absent",
  );
});

test("Responses Adapter: tolerates empty choices, missing usage and malformed tool calls", () => {
  const empty = chatCompletionsToResponses(
    {
      id: "chatcmpl-empty",
      object: "chat.completion",
      created: 1700000000,
      model: "qwen3.7-plus",
      choices: [],
    } as any,
    "qwen3.7-plus",
    { input: "Hello", model: "qwen3.7-plus" },
  );
  assert.deepEqual(empty.output, []);
  assert.ok(empty.usage);
  assert.equal(empty.usage.input_tokens, 0);
  assert.equal(empty.usage.total_tokens, 0);

  const malformed = chatCompletionsToResponses(
    {
      id: "chatcmpl-malformed",
      object: "chat.completion",
      created: 1700000000,
      model: "qwen3.7-plus",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "ok",
            tool_calls: [
              null,
              42,
              { id: "call_missing_function" },
              {
                id: "call_valid",
                type: "function",
                function: { name: "search", arguments: '{"q":"x"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    } as any,
    "qwen3.7-plus",
    { input: "Hello", model: "qwen3.7-plus" },
  );

  const functionCalls = malformed.output.filter(
    (item) => item.type === "function_call",
  );
  assert.equal(functionCalls.length, 1);
  assert.equal(functionCalls[0].name, "search");
});

test("Responses Streaming: skips malformed tool call entries without dropping text", () => {
  const state = createStreamState("resp_stream_malformed", "qwen3.7-plus");
  const events = processChatChunk(
    {
      id: "chatcmpl-test",
      choices: [
        {
          index: 0,
          delta: {
            content: "still here",
            tool_calls: [null, 42],
          },
        },
      ],
    },
    state,
  );

  assert.ok(
    events.some((event) => event.type === "response.output_text.delta"),
  );
});

test("Responses Streaming: processes delta text, tool calls, and finalizes output", () => {
  const state = createStreamState("resp_stream_test", "qwen3.7-plus");

  // 1. Text chunk delta
  const textEvents = processChatChunk(
    {
      id: "chatcmpl-test",
      choices: [{ index: 0, delta: { content: "Hello " } }],
    },
    state,
  );
  assert.ok(textEvents.length > 0);
  assert.ok(textEvents.some((e) => e.type === "response.output_text.delta"));

  // 2. Reasoning chunk delta
  const reasonEvents = processChatChunk(
    {
      id: "chatcmpl-test",
      choices: [{ index: 0, delta: { reasoning_content: "Thinking step..." } }],
    },
    state,
  );
  assert.ok(reasonEvents.length > 0);

  // 3. Tool call delta
  const toolEvents = processChatChunk(
    {
      id: "chatcmpl-test",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_tool_1",
                function: { name: "search", arguments: '{"q":' },
              },
            ],
          },
        },
      ],
    },
    state,
  );
  assert.ok(toolEvents.length > 0);

  // 4. Usage chunk
  processChatChunk(
    {
      id: "chatcmpl-test",
      choices: [{ index: 0, delta: {} }],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 30,
        total_tokens: 80,
      },
    },
    state,
  );

  // 5. Finalize
  const finalOutput = buildFinalOutput(state);
  assert.ok(finalOutput.length >= 1);

  const finalUsage = buildFinalUsage(state, 30);
  assert.equal(finalUsage.input_tokens, 50);
  assert.equal(finalUsage.output_tokens, 30);
  assert.equal(finalUsage.total_tokens, 80);
});

test("POST /v1/responses propagates the inner chat error status", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = "";
  let seenSignal: AbortSignal | undefined;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    seenUrl = String(input);
    seenSignal = init?.signal ?? undefined;
    return new Response(
      JSON.stringify({
        error: { message: "Quota exceeded", type: "rate_limit_error" },
      }),
      {
        status: 429,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const res = await app.fetch(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "qwen3.7-plus", input: "Hello" }),
      }),
    );

    assert.ok(seenUrl.includes("/v1/chat/completions"));
    assert.ok(seenSignal instanceof AbortSignal);
    assert.equal(res.status, 429);
    const data = (await res.json()) as any;
    assert.equal(data.error.type, "rate_limit_error");
    assert.equal(data.error.message, "Quota exceeded");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Responses HTTP Endpoints: GET, POST, and DELETE via app.fetch", async () => {
  // 1. POST with invalid JSON
  let res = await app.fetch(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "INVALID_JSON",
    }),
  );
  assert.equal(res.status, 400);

  // 2. POST with missing model
  res = await app.fetch(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "Hello" }),
    }),
  );
  assert.equal(res.status, 400);

  // 3. POST with non-existent previous_response_id
  res = await app.fetch(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.7-plus",
        input: "Follow up",
        previous_response_id: "resp_missing_123",
      }),
    }),
  );
  assert.equal(res.status, 404);

  // 4. GET non-existent response
  res = await app.fetch(new Request("http://localhost/v1/responses/resp_404_not_found"));
  assert.equal(res.status, 404);

  // 5. Store response and GET it
  const testId = "resp_endpoint_test_42";
  storeResponse(
    testId,
    {
      id: testId,
      object: "response",
      created_at: 1700000000,
      model: "qwen3.7-plus",
      status: "completed",
      output: [],
      usage: {
        input_tokens: 5,
        output_tokens: 5,
        total_tokens: 10,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
    [{ role: "user", content: "test" }],
  );

  res = await app.fetch(new Request(`http://localhost/v1/responses/${testId}`));
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.id, testId);

  // 6. DELETE response
  res = await app.fetch(
    new Request(`http://localhost/v1/responses/${testId}`, { method: "DELETE" }),
  );
  assert.equal(res.status, 200);
  const delData = (await res.json()) as any;
  assert.equal(delData.deleted, true);

  // 7. GET after DELETE returns 404
  res = await app.fetch(new Request(`http://localhost/v1/responses/${testId}`));
  assert.equal(res.status, 404);

  // 8. DELETE of a missing response returns 404 (matches the OpenAPI contract)
  res = await app.fetch(
    new Request("http://localhost/v1/responses/resp_missing_delete", {
      method: "DELETE",
    }),
  );
  assert.equal(res.status, 404);
});
