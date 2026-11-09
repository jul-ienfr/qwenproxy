import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { app } from "../api/server.ts";
import {
  docsApp,
  loadOpenApiDocument,
  resetOpenApiCacheForTesting,
  resolveOpenApiPath,
} from "../api/docs.ts";

type JsonRecord = Record<string, any>;

interface ValidationIssue {
  path: string;
  message: string;
}

function resolvePointer(root: JsonRecord, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let node: any = root;
  for (const raw of ref.slice(2).split("/")) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!node || typeof node !== "object") return undefined;
    node = node[part];
  }
  return node;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}

function enumEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validateValue(
  value: unknown,
  schema: JsonRecord | undefined,
  root: JsonRecord,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!schema || typeof schema !== "object") return;

  if (typeof schema.$ref === "string") {
    const resolved = resolvePointer(root, schema.$ref);
    if (!resolved) {
      issues.push({ path, message: `unresolved $ref ${schema.$ref}` });
      return;
    }
    validateValue(value, resolved as JsonRecord, root, path, issues);
    return;
  }

  if (Array.isArray(schema.allOf)) {
    for (const entry of schema.allOf) {
      validateValue(value, entry, root, path, issues);
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((entry: JsonRecord) => {
      const local: ValidationIssue[] = [];
      validateValue(value, entry, root, path, local);
      return local.length === 0;
    });
    if (matches.length !== 1) {
      issues.push({
        path,
        message: `oneOf matched ${matches.length} branches (expected exactly 1)`,
      });
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((entry: JsonRecord) => {
      const local: ValidationIssue[] = [];
      validateValue(value, entry, root, path, local);
      return local.length === 0;
    });
    if (!matched) {
      issues.push({ path, message: "anyOf matched no branch" });
    }
  }

  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type)
      ? schema.type
      : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      issues.push({
        path,
        message: `expected type ${types.join("|")}, got ${describeType(value)}`,
      });
      return;
    }
  }

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((entry: unknown) => enumEqual(entry, value))) {
      issues.push({
        path,
        message: `value ${JSON.stringify(value)} is not in the enum`,
      });
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      issues.push({ path, message: `value ${value} < minimum ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      issues.push({ path, message: `value ${value} > maximum ${schema.maximum}` });
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      issues.push({ path, message: `string shorter than ${schema.minLength}` });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      issues.push({ path, message: `string longer than ${schema.maxLength}` });
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      issues.push({ path, message: `string does not match ${schema.pattern}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      issues.push({ path, message: `array shorter than ${schema.minItems}` });
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      issues.push({ path, message: `array longer than ${schema.maxItems}` });
    }
    if (schema.items && typeof schema.items === "object") {
      value.forEach((entry, index) => {
        validateValue(entry, schema.items, root, `${path}[${index}]`, issues);
      });
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const required of schema.required || []) {
      if (!(required in record)) {
        issues.push({ path, message: `missing required property '${required}'` });
      }
    }
    const properties = schema.properties || {};
    for (const [key, entry] of Object.entries(record)) {
      if (properties[key]) {
        validateValue(entry, properties[key], root, `${path}/${key}`, issues);
      } else if (schema.additionalProperties === false) {
        issues.push({ path, message: `unexpected property '${key}'` });
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      ) {
        validateValue(
          entry,
          schema.additionalProperties,
          root,
          `${path}/${key}`,
          issues,
        );
      }
    }
  }
}

function collectExamples(document: JsonRecord): Array<{
  label: string;
  value: unknown;
  schema: JsonRecord | undefined;
}> {
  const examples: Array<{
    label: string;
    value: unknown;
    schema: JsonRecord | undefined;
  }> = [];

  const fromContent = (
    content: JsonRecord | undefined,
    schemaFallback: JsonRecord | undefined,
    label: string,
  ) => {
    if (!content || typeof content !== "object") return;
    for (const [mediaType, media] of Object.entries(content)) {
      const mediaRecord = (media || {}) as JsonRecord;
      const schema = (mediaRecord.schema as JsonRecord) || schemaFallback;
      if (mediaRecord.example !== undefined) {
        examples.push({ label: `${label} [${mediaType}]`, value: mediaRecord.example, schema });
      }
      if (mediaRecord.examples && typeof mediaRecord.examples === "object") {
        for (const [name, entry] of Object.entries(mediaRecord.examples)) {
          const exampleRecord = (entry || {}) as JsonRecord;
          if (exampleRecord.value !== undefined) {
            examples.push({
              label: `${label} [${mediaType}] example '${name}'`,
              value: exampleRecord.value,
              schema,
            });
          }
        }
      }
    }
  };

  for (const [route, item] of Object.entries(document.paths || {})) {
    for (const [method, operation] of Object.entries(item as JsonRecord)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const op = operation as JsonRecord;
      const label = `${method.toUpperCase()} ${route}`;

      fromContent(
        op.requestBody?.content,
        op.requestBody?.schema,
        `${label} request`,
      );

      for (const parameter of op.parameters || []) {
        if (parameter?.example !== undefined) {
          examples.push({
            label: `${label} parameter '${parameter.name}'`,
            value: parameter.example,
            schema: parameter.schema,
          });
        }
        for (const [name, entry] of Object.entries(parameter?.examples || {})) {
          const exampleRecord = (entry || {}) as JsonRecord;
          if (exampleRecord.value !== undefined) {
            examples.push({
              label: `${label} parameter '${parameter.name}' example '${name}'`,
              value: exampleRecord.value,
              schema: parameter.schema,
            });
          }
        }
      }

      for (const [status, response] of Object.entries(op.responses || {})) {
        const responseRecord = (response || {}) as JsonRecord;
        fromContent(
          responseRecord.content,
          responseRecord.schema,
          `${label} response ${status}`,
        );
      }
    }
  }

  return examples;
}

function publicRoutes(): Array<{ method: string; path: string }> {
  const operational = new Set([
    "/health",
    "/metrics",
    "/logs",
    "/logs/live",
    "/diagnostics/tokens",
    "/openapi.json",
    "/docs",
  ]);

  const routes: Array<{ method: string; path: string }> = [];
  for (const route of app.routes) {
    if (route.method === "ALL") continue;
    if (route.path.startsWith("/admin")) continue;
    if (route.path === "/*") continue;
    const isApi =
      route.path.startsWith("/v1/") ||
      route.path.startsWith("/v1beta/") ||
      operational.has(route.path);
    if (!isApi) continue;
    if (route.path === "/v1/*" || route.path === "/v1beta/*") continue;
    routes.push({ method: route.method, path: route.path });
  }
  return routes;
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

test("OpenAPI: contract is available offline and is valid OpenAPI 3.1", () => {
  const file = resolveOpenApiPath();
  assert.ok(file, "docs/openapi.yaml or docs/openapi.json must exist");

  const document = loadOpenApiDocument();
  assert.match(String(document.openapi), /^3\.1\./);
  assert.ok(document.info && typeof document.info === "object");
  assert.ok(document.paths && typeof document.paths === "object");
  assert.ok(document.components && typeof document.components === "object");
  assert.ok(Object.keys(document.paths).length > 0, "contract has no paths");

  const text = fs.readFileSync(file!, "utf8");
  // FR-007: no credentials or key material in the committed contract.
  assert.doesNotMatch(text, /qpx-[a-f0-9]{16,}/i);
  assert.doesNotMatch(text, /sk-[A-Za-z0-9_-]{16,}/);
  assert.doesNotMatch(text, /AIza[0-9A-Za-z_-]{20,}/);
  assert.doesNotMatch(text, /Bearer\s+[A-Za-z0-9._-]{20,}/);
});

test("OpenAPI: every public route is covered by the contract", () => {
  const document = loadOpenApiDocument();
  const paths = document.paths as JsonRecord;
  const missing: string[] = [];

  for (const route of publicRoutes()) {
    // Hono cannot register two methods that differ only by the `:action`
    // suffix, so the Gemini routes share a wildcard. Both methods must still
    // be present in the contract.
    if (route.path === "/v1beta/models/*") {
      for (const action of ["generateContent", "streamGenerateContent"]) {
        const contractPath = `/v1beta/models/{model}:${action}`;
        if (!paths[contractPath]?.post) {
          missing.push(`POST ${contractPath}`);
        }
      }
      continue;
    }

    const contractPath = toOpenApiPath(route.path);
    const methods = paths[contractPath];
    if (!methods || !methods[route.method.toLowerCase()]) {
      missing.push(`${route.method} ${route.path} -> ${contractPath}`);
    }
  }

  assert.deepEqual(missing, [], `routes missing from the contract:\n${missing.join("\n")}`);
});

test("OpenAPI: all examples validate against their schemas", () => {
  const document = loadOpenApiDocument();
  const examples = collectExamples(document);
  assert.ok(examples.length > 0, "contract has no examples");

  const issues: string[] = [];
  for (const example of examples) {
    const local: ValidationIssue[] = [];
    validateValue(example.value, example.schema, document, "#", local);
    for (const issue of local) {
      issues.push(`${example.label}${issue.path}: ${issue.message}`);
    }
  }

  assert.deepEqual(issues, [], `invalid contract examples:\n${issues.join("\n")}`);
});

test("OpenAPI: /openapi.json and /docs are served without external dependencies", async () => {
  resetOpenApiCacheForTesting();

  const contractResponse = await app.request("/openapi.json");
  assert.equal(contractResponse.status, 200);
  assert.match(contractResponse.headers.get("content-type") || "", /application\/json/);
  const served = (await contractResponse.json()) as JsonRecord;
  assert.match(String(served.openapi), /^3\.1\./);
  assert.ok(served.paths["/v1/chat/completions"]);
  assert.ok(served.paths["/v1/messages"]);
  assert.ok(served.paths["/v1beta/models/{model}:generateContent"]);

  const docsResponse = await docsApp.request("/docs");
  assert.equal(docsResponse.status, 200);
  assert.match(docsResponse.headers.get("content-type") || "", /text\/html/);
  const html = await docsResponse.text();
  assert.match(html, /QwenProxy API/);
  assert.match(html, /\/openapi\.json/);
  assert.doesNotMatch(html, /localStorage|sessionStorage/);
  assert.doesNotMatch(html, /<script[^>]+src=/i, "docs page must not load external scripts");
  assert.doesNotMatch(html, /<link[^>]+href=["']https?:/i, "docs page must not load external styles");
});

test("OpenAPI: error envelopes are documented for every protocol", () => {
  const document = loadOpenApiDocument();
  const components = (document.components || {}) as JsonRecord;
  const schemas = (components.schemas || {}) as JsonRecord;
  const responses = (components.responses || {}) as JsonRecord;

  assert.ok(schemas.ErrorResponse, "OpenAI/Responses error envelope");
  assert.ok(schemas.AnthropicError, "Anthropic error envelope");
  assert.ok(schemas.GeminiError, "Gemini error envelope");

  assert.ok(responses.AnthropicBadRequest);
  assert.ok(responses.AnthropicUnauthorized);
  assert.ok(responses.GeminiInvalidArgument);
  assert.ok(responses.BadRequest);
});
