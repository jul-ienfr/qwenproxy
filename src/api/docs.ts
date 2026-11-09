/**
 * OpenAPI contract and interactive API documentation.
 *
 * The contract lives in `docs/openapi.yaml` so it is reviewable in the
 * repository and available offline. This module parses it once (and re-parses
 * when the file changes during development) and serves:
 *
 *   GET /openapi.json  machine-readable OpenAPI 3.1 document
 *   GET /docs          self-contained interactive viewer (no CDN)
 *
 * Both routes are intentionally public: they contain no credentials or account
 * identifiers, and the spec requires the contract to remain usable when the
 * proxy has no accounts configured. The docs page keeps the operator-entered
 * API key in a JavaScript variable only; it is never written to localStorage,
 * sessionStorage or the URL.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { parse as parseYaml } from "yaml";
import { logger } from "../core/logger.js";

const app = new Hono();

type JsonRecord = Record<string, unknown>;

interface CachedDocument {
  file: string;
  mtimeMs: number;
  document: JsonRecord;
}

let cached: CachedDocument | null = null;

/**
 * Candidate contract locations, in priority order:
 *  - the working directory (npm start / Docker WORKDIR),
 *  - the source tree (tsx dev: src/api -> ../../docs),
 *  - the bundled layout (dist/index.js -> ../docs).
 */
function candidatePaths(): string[] {
  const fromModule = (relative: string): string | null => {
    try {
      return fileURLToPath(new URL(relative, import.meta.url));
    } catch {
      return null;
    }
  };

  return [
    path.resolve(process.cwd(), "docs/openapi.yaml"),
    path.resolve(process.cwd(), "docs/openapi.json"),
    fromModule("../../docs/openapi.yaml"),
    fromModule("../../docs/openapi.json"),
    fromModule("../docs/openapi.yaml"),
    fromModule("../docs/openapi.json"),
  ].filter((entry): entry is string => Boolean(entry));
}

export function resolveOpenApiPath(): string | null {
  for (const candidate of candidatePaths()) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next location.
    }
  }
  return null;
}

/**
 * Load and parse the contract. Cached by path + mtime so repeated requests are
 * cheap while edits are picked up without restarting the server.
 */
export function loadOpenApiDocument(): JsonRecord {
  const file = resolveOpenApiPath();
  if (!file) {
    throw new Error(
      "OpenAPI contract not found (looked for docs/openapi.yaml or docs/openapi.json)",
    );
  }

  const stat = fs.statSync(file);
  if (cached && cached.file === file && cached.mtimeMs === stat.mtimeMs) {
    return cached.document;
  }

  const raw = fs.readFileSync(file, "utf8");
  const parsed = file.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`OpenAPI contract at ${file} is not an object`);
  }

  cached = { file, mtimeMs: stat.mtimeMs, document: parsed as JsonRecord };
  return cached.document;
}

/** Test helper: drop the cached document. */
export function resetOpenApiCacheForTesting(): void {
  cached = null;
}

app.get("/openapi.json", (c) => {
  try {
    return c.json(loadOpenApiDocument() as any);
  } catch (error) {
    logger.error("[Docs] Failed to load OpenAPI contract", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(
      {
        error: {
          message: "OpenAPI contract unavailable",
          type: "internal_error",
        },
      },
      500,
    );
  }
});

app.get("/docs", (c) => {
  return c.html(DOCS_HTML);
});

export { app as docsApp };

/**
 * The viewer is deliberately dependency-free: inline CSS/JS, no CDN, no
 * external fonts. It fetches /openapi.json, renders the operation list and
 * offers a small "try it" form per JSON operation.
 */
const DOCS_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QwenProxy API Docs</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #0f1115;
    --panel: #171a21;
    --panel-2: #1e222b;
    --border: #2c3240;
    --text: #e6e9ef;
    --muted: #9aa4b2;
    --accent: #7aa2ff;
    --get: #2ea043;
    --post: #1f6feb;
    --delete: #da3633;
    --patch: #9e6a03;
    --put: #8957e5;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f8fa;
      --panel: #ffffff;
      --panel-2: #f0f3f6;
      --border: #d0d7de;
      --text: #1f2328;
      --muted: #57606a;
      --accent: #0969da;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    padding: 12px 18px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  header h1 { font-size: 16px; margin: 0; }
  header .version { color: var(--muted); font-size: 12px; }
  header .auth {
    margin-left: auto;
    display: flex;
    gap: 8px;
    align-items: center;
  }
  header input[type="password"] {
    width: 260px;
    padding: 7px 9px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel-2);
    color: var(--text);
  }
  header .note { color: var(--muted); font-size: 12px; }
  .layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); min-height: calc(100vh - 61px); }
  nav {
    border-right: 1px solid var(--border);
    padding: 12px;
    overflow: auto;
    max-height: calc(100vh - 61px);
    position: sticky;
    top: 61px;
  }
  nav input[type="search"] {
    width: 100%;
    padding: 7px 9px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel-2);
    color: var(--text);
    margin-bottom: 10px;
  }
  nav h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 14px 0 6px; }
  nav a {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 5px 6px;
    border-radius: 5px;
    color: var(--text);
    text-decoration: none;
    font-size: 13px;
    word-break: break-all;
  }
  nav a:hover { background: var(--panel-2); }
  main { padding: 18px 24px 80px; max-width: 1100px; }
  .intro { color: var(--muted); margin-bottom: 18px; }
  .intro code { color: var(--text); }
  .op {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px 18px;
    margin-bottom: 16px;
  }
  .op h3 { margin: 0 0 6px; font-size: 16px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .op .path { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; }
  .op .summary { color: var(--muted); margin: 0 0 8px; }
  .op .description { white-space: pre-wrap; margin: 8px 0; }
  .method {
    display: inline-block;
    min-width: 58px;
    text-align: center;
    padding: 2px 7px;
    border-radius: 5px;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .04em;
  }
  .method.GET { background: var(--get); }
  .method.POST { background: var(--post); }
  .method.DELETE { background: var(--delete); }
  .method.PATCH { background: var(--patch); }
  .method.PUT { background: var(--put); }
  .method.OTHER { background: var(--muted); }
  table.params { border-collapse: collapse; width: 100%; margin: 8px 0; }
  table.params th, table.params td { text-align: left; border-bottom: 1px solid var(--border); padding: 5px 6px; font-size: 13px; }
  table.params th { color: var(--muted); font-weight: 600; }
  .try { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 12px; }
  .try h4 { margin: 0 0 8px; font-size: 13px; }
  .field { display: flex; gap: 8px; align-items: center; margin: 6px 0; }
  .field label { min-width: 160px; color: var(--muted); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .field input, .field textarea {
    flex: 1;
    padding: 7px 9px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel-2);
    color: var(--text);
    font: inherit;
  }
  .field textarea { min-height: 150px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
  button {
    padding: 7px 14px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--accent);
    color: #fff;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  button:disabled { opacity: .6; cursor: wait; }
  .result { margin-top: 10px; }
  .result .meta { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
  .result pre {
    margin: 0;
    padding: 10px 12px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: auto;
    max-height: 420px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .hint { color: var(--muted); font-size: 12px; }
  .multipart { color: var(--muted); font-size: 13px; }
  @media (max-width: 820px) {
    .layout { grid-template-columns: 1fr; }
    nav { position: static; max-height: none; border-right: 0; border-bottom: 1px solid var(--border); }
    header .auth { margin-left: 0; width: 100%; }
    header input[type="password"] { width: 100%; }
  }
</style>
</head>
<body>
<header>
  <div>
    <h1>QwenProxy API</h1>
    <div class="version" id="version"></div>
  </div>
  <div class="auth">
    <input id="apiKey" type="password" placeholder="API key (Bearer / x-api-key)" autocomplete="off" spellcheck="false">
    <span class="note">Kept in memory for this tab only</span>
  </div>
</header>
<div class="layout">
  <nav>
    <input id="filter" type="search" placeholder="Filter endpoints" autocomplete="off">
    <div id="nav"></div>
  </nav>
  <main>
    <p class="intro">
      This page is generated from <code>/openapi.json</code>. Operations marked
      with a <strong>Try it</strong> form send requests to this proxy using the
      key above. Streaming endpoints are read as server-sent events.
    </p>
    <div id="ops"><p class="hint">Loading contract...</p></div>
  </main>
</div>
<script>
(function () {
  "use strict";

  var state = { doc: null, apiKey: "" };
  var keyInput = document.getElementById("apiKey");
  keyInput.addEventListener("input", function () {
    state.apiKey = keyInput.value.trim();
  });

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function resolveRef(ref) {
    if (!ref || ref.charAt(0) !== "#") return null;
    var parts = ref.slice(2).split("/");
    var node = state.doc;
    for (var i = 0; i < parts.length; i++) {
      if (!node || typeof node !== "object") return null;
      var part = parts[i].replace(/~1/g, "/").replace(/~0/g, "~");
      node = node[part];
    }
    return node || null;
  }

  function deref(node) {
    var seen = 0;
    while (node && typeof node === "object" && typeof node.$ref === "string" && seen < 20) {
      node = resolveRef(node.$ref);
      seen++;
    }
    return node;
  }

  function schemaExample(schema) {
    schema = deref(schema);
    if (!schema || typeof schema !== "object") return undefined;
    if (schema.example !== undefined) return schema.example;
    if (schema.default !== undefined) return schema.default;
    if (schema.enum && schema.enum.length) return schema.enum[0];
    if (schema.oneOf && schema.oneOf.length) return schemaExample(schema.oneOf[0]);
    if (schema.anyOf && schema.anyOf.length) return schemaExample(schema.anyOf[0]);
    if (schema.type === "object" || schema.properties) {
      var out = {};
      var props = schema.properties || {};
      Object.keys(props).forEach(function (name) {
        var value = schemaExample(props[name]);
        if (value !== undefined) out[name] = value;
      });
      return out;
    }
    if (schema.type === "array") {
      var item = schemaExample(schema.items);
      return item === undefined ? [] : [item];
    }
    if (schema.type === "string") return "";
    if (schema.type === "integer" || schema.type === "number") return 0;
    if (schema.type === "boolean") return false;
    return undefined;
  }

  function bodyExample(operation) {
    var body = operation.requestBody;
    body = deref(body);
    if (!body || !body.content) return null;
    var json = body.content["application/json"];
    if (!json) return null;
    var schema = deref(json.schema);
    if (json.examples) {
      var names = Object.keys(json.examples);
      if (names.length) {
        var ex = deref(json.examples[names[0]]);
        if (ex && ex.value !== undefined) return ex.value;
      }
    }
    if (json.example !== undefined) return json.example;
    if (schema && schema.example !== undefined) return schema.example;
    var generated = schemaExample(schema);
    return generated === undefined ? {} : generated;
  }

  function operations() {
    var out = [];
    var paths = state.doc.paths || {};
    Object.keys(paths).forEach(function (route) {
      var item = paths[route] || {};
      Object.keys(item).forEach(function (method) {
        if (["get", "post", "put", "patch", "delete", "options", "head"].indexOf(method) === -1) return;
        var op = item[method] || {};
        out.push({
          method: method.toUpperCase(),
          path: route,
          operation: op,
          id: "op-" + method + "-" + route.replace(/[^a-zA-Z0-9]+/g, "-")
        });
      });
    });
    return out;
  }

  function renderNav(ops) {
    var nav = document.getElementById("nav");
    nav.innerHTML = "";
    var groups = {};
    ops.forEach(function (entry) {
      var tags = entry.operation.tags && entry.operation.tags.length ? entry.operation.tags : ["Other"];
      tags.forEach(function (tag) {
        if (!groups[tag]) groups[tag] = [];
        groups[tag].push(entry);
      });
    });
    Object.keys(groups).sort().forEach(function (tag) {
      var h = document.createElement("h2");
      h.textContent = tag;
      nav.appendChild(h);
      groups[tag].forEach(function (entry) {
        var a = document.createElement("a");
        a.href = "#" + entry.id;
        a.setAttribute("data-search", (entry.method + " " + entry.path + " " + (entry.operation.summary || "")).toLowerCase());
        var badge = document.createElement("span");
        badge.className = "method " + entry.method;
        badge.textContent = entry.method;
        var label = document.createElement("span");
        label.textContent = entry.path;
        a.appendChild(badge);
        a.appendChild(label);
        nav.appendChild(a);
      });
    });
  }

  function paramRows(operation) {
    var params = [];
    (operation.parameters || []).forEach(function (p) { params.push(deref(p)); });
    var body = deref(operation.requestBody);
    return params.filter(Boolean);
  }

  function renderOperation(entry) {
    var op = entry.operation;
    var section = document.createElement("section");
    section.className = "op";
    section.id = entry.id;

    var title = document.createElement("h3");
    var badge = document.createElement("span");
    badge.className = "method " + entry.method;
    badge.textContent = entry.method;
    var pathEl = document.createElement("span");
    pathEl.className = "path";
    pathEl.textContent = entry.path;
    title.appendChild(badge);
    title.appendChild(pathEl);
    section.appendChild(title);

    if (op.summary) {
      var summary = document.createElement("p");
      summary.className = "summary";
      summary.textContent = op.summary;
      section.appendChild(summary);
    }
    if (op.description) {
      var desc = document.createElement("div");
      desc.className = "description";
      desc.textContent = op.description;
      section.appendChild(desc);
    }

    var params = paramRows(op);
    if (params.length) {
      var table = document.createElement("table");
      table.className = "params";
      table.innerHTML = "<thead><tr><th>Name</th><th>In</th><th>Required</th><th>Description</th></tr></thead>";
      var tbody = document.createElement("tbody");
      params.forEach(function (p) {
        var tr = document.createElement("tr");
        [p.name || "", p.in || "", p.required ? "yes" : "no", p.description || ""].forEach(function (value) {
          var td = document.createElement("td");
          td.textContent = value;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      section.appendChild(table);
    }

    var body = deref(op.requestBody);
    var multipart = body && body.content && body.content["multipart/form-data"];
    var jsonExample = bodyExample(op);

    if (multipart && !jsonExample) {
      var note = document.createElement("p");
      note.className = "multipart";
      note.textContent = "Multipart form-data endpoint. Use curl or an SDK to upload files; this viewer only sends JSON bodies.";
      section.appendChild(note);
      return section;
    }

    var tryBox = document.createElement("div");
    tryBox.className = "try";
    var heading = document.createElement("h4");
    heading.textContent = "Try it";
    tryBox.appendChild(heading);

    var inputs = {};
    params.forEach(function (p) {
      if (p.in !== "path" && p.in !== "query") return;
      var row = document.createElement("div");
      row.className = "field";
      var label = document.createElement("label");
      label.textContent = p.name + (p.required ? " *" : "");
      var input = document.createElement("input");
      input.type = "text";
      input.placeholder = p.in;
      input.setAttribute("data-param", p.name);
      input.setAttribute("data-in", p.in);
      row.appendChild(label);
      row.appendChild(input);
      tryBox.appendChild(row);
      inputs[p.name] = input;
    });

    var bodyArea = null;
    if (jsonExample !== null) {
      var bodyRow = document.createElement("div");
      bodyRow.className = "field";
      var bodyLabel = document.createElement("label");
      bodyLabel.textContent = "JSON body";
      bodyArea = document.createElement("textarea");
      bodyArea.value = JSON.stringify(jsonExample, null, 2);
      bodyArea.spellcheck = false;
      bodyRow.appendChild(bodyLabel);
      bodyRow.appendChild(bodyArea);
      tryBox.appendChild(bodyRow);
    }

    var send = document.createElement("button");
    send.type = "button";
    send.textContent = "Send request";
    var result = document.createElement("div");
    result.className = "result";
    tryBox.appendChild(send);
    tryBox.appendChild(result);

    send.addEventListener("click", function () {
      send.disabled = true;
      result.innerHTML = "";
      var meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = "Waiting...";
      var pre = document.createElement("pre");
      pre.textContent = "";
      result.appendChild(meta);
      result.appendChild(pre);

      var url = entry.path;
      Object.keys(inputs).forEach(function (name) {
        var input = inputs[name];
        var value = input.value;
        if (input.getAttribute("data-in") === "path") {
          url = url.replace("{" + name + "}", encodeURIComponent(value));
        }
      });
      var query = [];
      Object.keys(inputs).forEach(function (name) {
        var input = inputs[name];
        if (input.getAttribute("data-in") === "query" && input.value !== "") {
          query.push(encodeURIComponent(name) + "=" + encodeURIComponent(input.value));
        }
      });
      if (query.length) url += (url.indexOf("?") === -1 ? "?" : "&") + query.join("&");

      var headers = { "Accept": "application/json, text/event-stream" };
      if (state.apiKey) {
        headers["Authorization"] = "Bearer " + state.apiKey;
        headers["x-api-key"] = state.apiKey;
        if (entry.path.indexOf("/v1beta/") === 0) headers["x-goog-api-key"] = state.apiKey;
      }
      var init = { method: entry.method, headers: headers };
      if (bodyArea) {
        headers["Content-Type"] = "application/json";
        init.body = bodyArea.value;
      }

      fetch(url, init).then(function (response) {
        meta.textContent = "HTTP " + response.status + " " + response.statusText + " - " + (response.headers.get("content-type") || "unknown content type");
        var contentType = response.headers.get("content-type") || "";
        if (contentType.indexOf("text/event-stream") !== -1 && response.body) {
          var reader = response.body.getReader();
          var decoder = new TextDecoder();
          var pump = function () {
            return reader.read().then(function (chunk) {
              if (chunk.done) {
                meta.textContent += " (stream closed)";
                return;
              }
              pre.textContent += decoder.decode(chunk.value, { stream: true });
              pre.scrollTop = pre.scrollHeight;
              return pump();
            });
          };
          return pump();
        }
        return response.text().then(function (text) {
          var output = text;
          try { output = JSON.stringify(JSON.parse(text), null, 2); } catch (ignore) {}
          pre.textContent = output;
        });
      }).catch(function (error) {
        meta.textContent = "Request failed";
        pre.textContent = String(error);
      }).finally(function () {
        send.disabled = false;
      });
    });

    section.appendChild(tryBox);
    return section;
  }

  function render() {
    var ops = operations();
    renderNav(ops);
    var container = document.getElementById("ops");
    container.innerHTML = "";
    ops.forEach(function (entry) {
      container.appendChild(renderOperation(entry));
    });

    var filter = document.getElementById("filter");
    filter.addEventListener("input", function () {
      var needle = filter.value.trim().toLowerCase();
      var links = document.querySelectorAll("#nav a");
      for (var i = 0; i < links.length; i++) {
        var haystack = links[i].getAttribute("data-search") || "";
        links[i].style.display = !needle || haystack.indexOf(needle) !== -1 ? "" : "none";
      }
    });
  }

  fetch("/openapi.json", { headers: { "Accept": "application/json" } })
    .then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    })
    .then(function (doc) {
      state.doc = doc;
      document.getElementById("version").textContent = (doc.info && doc.info.title ? doc.info.title : "QwenProxy API") + " " + (doc.info && doc.info.version ? doc.info.version : "");
      render();
    })
    .catch(function (error) {
      document.getElementById("ops").innerHTML = "";
      var p = document.createElement("p");
      p.className = "hint";
      p.textContent = "Failed to load /openapi.json: " + String(error);
      document.getElementById("ops").appendChild(p);
    });
})();
</script>
</body>
</html>`;
