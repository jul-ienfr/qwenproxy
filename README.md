<p align="center">
  <img src="docs/banner.webp" alt="QwenProxy" width="100%">
</p>

<p align="center">
  <b>English</b> ·
  <a href="README.pt-BR.md">Português</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a>
</p>

High-performance OpenAI-, Anthropic- and Gemini-compatible API gateway that bridges modern AI coding agents and clients (Claude Code CLI, OpenAI Codex, OpenCode, Cursor, OMP, Zed, Grok) to **Qwen (`chat.qwen.ai`)** with multi-account rotation, intelligent failover, robust tool calling, thread-native delta execution, image & video generation, **full OpenAI Responses API with persistent memory**, and durable sessions. Powered by stealth headless Chromium, transient retry ladders, public base/`-fast`/`-thinking` variants, compressed caching, dynamic model capability registry, and full observability.

---

> **Fork notice / Avis de fork**
>
> This repository is a personal fork of **[johngbl/qwenproxy](https://github.com/johngbl/qwenproxy)**, which is itself derived from **[pedrofariasx/qwenproxy](https://github.com/pedrofariasx/qwenproxy)**, originally created by **Pedro Farias**.
>
> - Original project: [pedrofariasx/qwenproxy](https://github.com/pedrofariasx/qwenproxy) - ISC License
> - Upstream fork: [johngbl/qwenproxy](https://github.com/johngbl/qwenproxy) - ISC License
> - This fork: [jul-ienfr/qwenproxy](https://github.com/jul-ienfr/qwenproxy)
>
> All credit for the original architecture, protocol work and code belongs to **Pedro Farias** and **johngbl**. This fork only adds local packaging, configuration and deployment changes; it does not claim authorship of the upstream code.
>
> Ce dépôt est un fork personnel de **[johngbl/qwenproxy](https://github.com/johngbl/qwenproxy)**, lui-même dérivé de **[pedrofariasx/qwenproxy](https://github.com/pedrofariasx/qwenproxy)**, créé par **Pedro Farias**. Tout le crédit du code et de l'architecture revient à Pedro Farias et johngbl.

---

[![CI](https://github.com/jul-ienfr/qwenproxy/actions/workflows/ci.yml/badge.svg)](https://github.com/jul-ienfr/qwenproxy/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/qwenproxy-cli.svg)](https://www.npmjs.com/package/qwenproxy-cli)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-blue)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono-4.13-green)](https://hono.dev/)
[![Patchright](https://img.shields.io/badge/Patchright-Stealth-blueviolet)](https://github.com/kaliiiiiiiiii/patchright)
[![License: ISC](https://img.shields.io/badge/License-ISC-yellow.svg)](LICENSE)
[![GitHub Sponsors](https://img.shields.io/badge/sponsor-GitHub%20Sponsors-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/johngbl)
[![Ko-fi](https://img.shields.io/badge/Donate-Ko--fi-ff5e5b?logo=kofi&logoColor=white)](https://ko-fi.com/johngbl)

## ❤️ Support the Project

If **QwenProxy** is helping you or your team and you would like to support continuous maintenance, new client integrations, live probes, and rapid upstream patches, consider voluntary sponsorship:

<a href="https://github.com/sponsors/johngbl" target="_blank"><img src="https://img.shields.io/badge/Sponsor%20on%20GitHub-ea4aaa?style=for-the-badge&logo=githubsponsors&logoColor=white" alt="GitHub Sponsors"></a> <a href="https://ko-fi.com/johngbl" target="_blank"><img src="https://img.shields.io/badge/Donate%20via%20Ko--fi-ff5e5b?style=for-the-badge&logo=kofi&logoColor=white" alt="Ko-fi"></a>

Every contribution helps cover infrastructure costs, proxy bandwidth, and test accounts!

> **Note for this fork:** these donation links support the upstream maintainer, **johngbl**. This fork does not collect donations.

---

## 🚀 Key Features

- **Native OpenAI, Anthropic & Gemini Compatibility** — `/v1/chat/completions`, `/v1/models`, `/v1/messages` (**native Anthropic Messages API** for **Claude Code CLI** and official `@anthropic-ai/sdk`), `/v1/messages/count_tokens`, **OpenAI Responses API** (`/v1/responses`), **Gemini `generateContent` / `streamGenerateContent`** (`/v1beta/models/{model}:...`), and `/v1/completions` (legacy adapter).
- **OpenAPI 3.1 Contract & Interactive Docs** — a machine-readable contract at `/openapi.json`, the canonical source at `docs/openapi.yaml`, and a dependency-free interactive explorer at `/docs` (API key kept in memory only).
- **Full 4-Mode Conversation Matrix** — `thread` (default persistent), `thread-temp` (delta ~1KB ephemeral, recommended for coding agents), `stateless-temp` (OpenAI official stateless standard, ephemeral), and `stateless` (OpenAI official stateless standard, saved to web account).
- **Real-Time Dynamic Mode Switching** — Switch the global proxy API mode instantly via TUI (`M` on the status screen or `F4` in Chat) or via `/v1/chat/mode` HTTP endpoint, without restarting the server.
- **Full Terminal Dashboard TUI (`qpx`)** — Interactive monospace UI with full mouse support (hover, click, drag, and scroll), vertical model/mode selectors, and native `QwenProxy` terminal window title.
- **Batch Account Import (`B`)** — Paste dozens of accounts in seconds (`email:password`, `.env` format, tab, pipe). Stored with at-rest encryption in a single SQLite transaction (<10ms) with deduplication and live count badges.
- **Dynamic Viewport Scrolling** — Smooth list navigation across 50+ accounts without layout overflow or column misalignment.
- **1-Click Coding Agent Sync (`qpx sync`)** — Automated setup for Claude Code, OpenAI Codex, OpenCode, Cline, OMP, Zed, Kilo Code, and Hermes with 1-click backup rollback.
- **Ultra-Light Single Chromium Instance** — 1 shared browser process with hardware WebGL acceleration and isolated `BrowserContext` storage states (~200MB RAM across all accounts, >65% resource reduction).
- **On-Demand Warmup & Multi-Account Pool** — Boots instantly with the **primary account ready**; standby accounts remain idle and warm up lazily on demand (during failover or rotation).
- **Clean Personalization Synchronization** — System prompts and tools ride account personalization (`/settings/personalization`), mirroring the official web client and avoiding WAF bot triggers.
- **Large-Context Externalization** — When the full agent history exceeds `QWEN_EXTERNALIZE_CONTEXT_BYTES` (default 90 KB) and the request carries tools, the history is uploaded as a Qwen text attachment and only the latest turn stays inline. This avoids Qwen's ~128 KiB WAF/captcha tripwire on long agentic loops. A prefix cache (`QWEN_EXTERNALIZE_CACHE_*`) reuses the previous attachment across turns and inlines only the delta, avoiding a 100–300 KB re-upload per agent turn.
- **Opt-In Web Search with Citations** — Enable Qwen web search per request (`web_search`, `web_search_options`, the `X-QwenProxy-Web-Search` header, or a `-search` model suffix). Returned sources are exposed as OpenAI-style `annotations` (`url_citation`) plus a `search_results` extension, with `X-QwenProxy-Web-Search` and `search` metadata reporting whether search actually ran.
- **Self-Healing Tool Call Parser** — Handles fragmented streams, broken JSON parameters, unified `<qpx_call>` tags, fuzzy name matching (`readFile` → `read_file`), and intelligent auto-retry ladders.
- **Image & Video Generation** — Dedicated `/v1/images/generations`, `/v1/images/edits` and `/v1/videos/generations` endpoints with flagship models (`qwen-image-3.0-pro`, `wan3.0-video`, `wan2.7-image-pro`). Image edits accept multipart `image` + `prompt` uploads (PNG/JPEG/WebP/GIF) and the same account/quota/captcha pipeline as generation.
- **Observability & Health Monitoring** — Real-time metrics at `/health`, `/metrics` (Prometheus), RSS watchdog, and unified clean log pairs per turn.

---

## 🏛️ Architecture

```mermaid
flowchart TD
    Client["Client: Claude Code / Codex / OpenCode / Cursor / OMP"] -->|HTTP / SSE| Proxy["QwenProxy - Hono"]
    Proxy --> Chat["/v1/chat/completions"]
    Proxy --> Anthropic["/v1/messages"]
    Proxy --> Gemini["/v1beta/models/{model}:generateContent"]
    Proxy --> Completions["/v1/completions (legacy)"]
    Proxy --> Responses["/v1/responses"]
    Proxy --> Media["/v1/images | /v1/videos"]
    Proxy --> Models["/v1/models"]
    Proxy --> Upload["/v1/upload"]
    Anthropic --> Chat
    Gemini --> Chat
    Completions --> Chat
    Responses --> Chat
    Responses --> Effort["Effort normalization"]
    Responses --> State[("SQLite responses_store")]
    Chat --> Context["Thread-native context"]
    Chat --> Accounts["Account manager"]
    Accounts --> DB[("SQLite encrypted")]
    Accounts --> Playwright["Playwright + Stealth"]
    Playwright --> Fingerprint["Fingerprint / session keeper"]
    Chat --> Parser["Tool-call parser"]
    Chat --> Personalization["Settings + personalization sync"]
    Chat --> BrowserTransport["Playwright page fetch + SSE bridge"]
    BrowserTransport --> Qwen["chat.qwen.ai"]
    Media --> BrowserTransport
    Upload --> OSS["Qwen OSS"]
```

---

## 🔄 Conversation Modes

QwenProxy provides a complete matrix of **4 conversation modes**, letting you choose the exact balance between token efficiency, latency, and history organization:

| Mode | Payload Strategy | Upstream Qwen Mode | Saved to Web Account? | Recommended Use Case |
| :--- | :--- | :--- | :---: | :--- |
| **`thread-temp`** ⭐ | **Delta (~1KB)** | `chat_mode: "local"` | ❌ No (Zero pollution) | **The best mode for daily development.** Recommended for Claude Code, Codex, OpenCode, and Cursor. Maximum speed, ultra-low TTFB, and zero sidebar clutter on `chat.qwen.ai`. |
| **`stateless-temp`** | **Full History** | `chat_mode: "local"` | ❌ No (Zero pollution) | **Official API Standard (OpenAI/Anthropic).** Resends full message history on every turn. Ideal if your client edits, prunes, or re-orders past turns mid-session. |
| **`thread`** *(Default)* | **Delta (~1KB)** | `chat_mode: "normal"` | ✅ Yes (Saved to web) | Perfect if you want to inspect or continue your agent's conversation later directly inside the official `chat.qwen.ai` mobile app or desktop browser. |
| **`stateless`** | **Full History** | `chat_mode: "normal"` | ✅ Yes (Saved to web) | Resends full message history on every turn while persisting every chat session into your Qwen account history. |

### How to Switch Modes:

1. **Via Interactive TUI (Real-Time Global Switch):**
   - **On `[1] Status` screen:** Press **`M`** (or click `[ M ] Alternar Modo`) to cycle the global API mode instantly.
   - **On `[2] Chat` screen:** Press **`F4`** (or click the `[ Modo ]` header button) to open the vertical modal selector.
2. **Via Remote HTTP Endpoint:**
   ```bash
   # Inspect active mode:
   curl http://127.0.0.1:7936/v1/chat/mode

   # Update mode globally in real time:
   curl -X POST http://127.0.0.1:7936/v1/chat/mode \
     -H "Content-Type: application/json" \
     -d '{"mode":"thread-temp"}'
   ```
3. **Per-Request Header Override:**
   Send `X-QwenProxy-Chat-Mode: thread-temp` (or `stateless-temp`, `thread`, `stateless`) in individual HTTP requests.
4. **Via `.env` Configuration (Boot Default):**
   ```env
   QWEN_CHAT_MODE=thread
   ```

---

## 📖 Step-by-Step: Getting Started

### 1. Installation

Install the QwenProxy CLI globally on your workstation:

```bash
# Via npm:
npm install -g qwenproxy-cli

# Or via pnpm / bun:
pnpm add -g qwenproxy-cli
# bun add -g qwenproxy-cli
```

Alternatively, download a standalone binary from the GitHub releases page
(Windows x64, Linux x64/arm64). No Node.js is required:

```bash
sha256sum -c SHA256SUMS
./qwenproxy-linux-x64 --version
```

Standalone binaries do not bundle Chromium: install Node.js and run
`npx patchright install chromium`, or use the Docker image. See
[docs/STANDALONE.md](docs/STANDALONE.md) for portable data/`.env` paths,
checksum verification and the unsigned-binary trust model.

### 2. Launch the Interactive Dashboard (TUI)

Open your terminal and run:

```bash
qpx
```

QwenProxy launches the high-performance proxy server in the background and opens the interactive dashboard. The terminal window title will automatically update to **`QwenProxy`**.

### 3. Add Qwen Accounts

> 🌐 **Where to create accounts?**  
> Create your free accounts directly on the official Qwen Web portal: **[https://chat.qwen.ai](https://chat.qwen.ai)**  
> 1. Go to **[chat.qwen.ai](https://chat.qwen.ai)** and click **Sign up**.
> 2. Register with your email and password (or Google login).
> 3. *Pro Tip:* Create 3 to 10 accounts so QwenProxy can automatically rotate between them when daily quotas are reached, giving you continuous uninterrupted coding!

Inside the TUI, navigate to tab **`[5] Accounts`** to manage credentials:

- **Batch Import (`B`):** Press **`B`** (or click `[ B ] Em Lote`). Paste your account credentials in bulk (`email:password` per line, raw `.env` string with commas, or spreadsheet paste). The parser calculates valid accounts in real time, handles special password characters safely, skips duplicates, and commits encrypted credentials to SQLite in a single transaction (<10ms).
- **Single Account (`A`):** Press **`A`** to manually type email and password.
- **Browser Login:** If you prefer visual login with manual captcha solving: `qpx login`.

### 4. Synchronize AI Coding Agents

To automatically configure your installed coding agents to route through QwenProxy:

```bash
# Automatically sync all detected agents:
qpx sync

# Or target specific agents:
qpx sync claude codex opencode
```

The synchronizer configures:
- **Claude Code CLI** (`~/.claude/settings.json`) — Native Anthropic protocol (`/v1/messages`).
- **OpenAI Codex CLI** (`~/.codex/config.toml`) — Native Responses protocol (`/v1/responses`).
- **OpenCode** (`~/.config/opencode/opencode.jsonc`) — OpenAI-compatible provider.
- **Cline, OMP, Zed, Kilo Code, and Hermes Agent**.
> **Rollback tip:** Restore previous client configuration backups anytime with `qpx sync --restore` (or `npm run sync:restore`).
### 5. Start Coding!

Launch your favorite coding tool as you normally would:
```bash
# Run Claude Code:
claude

# Run Codex CLI:
codex

# Run OpenCode:
opencode
```
All completions and tool calls will flow through your local QwenProxy gateway with zero external API fees, high context windows, and automatic multi-account rotation!

---

## 🌐 Per-Account Outbound Proxy

Each Qwen account can use its own HTTP/HTTPS/SOCKS5 outbound proxy. Resolution
order is **account proxy → `PROXY_URL` → direct**.

```bash
npm run proxy list
npm run proxy set account-a@example.com http://user:pass@proxy-a.example.com:8080
npm run proxy set account-b@example.com socks5://proxy-b.example.com:1080
npm run proxy clear account-a@example.com
npm run proxy test account-a@example.com
```

Proxy credentials are encrypted at rest and masked in the TUI, CLI and logs.
Changing a proxy closes only that account's browser context; the next request
relaunches it through the new egress. A proxy that cannot be reached marks the
account with the `ProxyUnavailable` cooldown reason and normal failover applies.

For Docker/CI, the optional `QWEN_ACCOUNT_PROXIES` environment variable accepts
`email=proxy` pairs separated by commas or semicolons.

---

## 🔑 Multi-User API Keys & Quotas

QwenProxy can issue per-consumer API keys with independent RPM and concurrent
stream limits. Keys are stored as SHA-256 hashes in SQLite; the plaintext key is
shown exactly once at creation or rotation.

```bash
# Create a user (unlimited by default)
npm run users create alice

# Rate limit: 60 requests/minute, max 2 concurrent streams
npm run users create alice --rpm 60 --concurrency 2

# Inspect, rotate, revoke
npm run users list
npm run users limits alice 120 4
npm run users rotate alice
npm run users revoke alice
```

Use the key exactly like the legacy global API key:

```bash
curl http://127.0.0.1:7936/v1/chat/completions \
  -H "Authorization: Bearer sk-qpx-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.8-max","messages":[{"role":"user","content":"hello"}]}'
```

**Quota behavior**

- `--rpm` uses a sliding 60-second window; `0` means unlimited.
- `--concurrency` limits active streams per key; `0` means unlimited.
- Exceeding either limit returns HTTP `429` with `Retry-After` **before** any
  Qwen account or browser work starts.
- Stream slots are released on completion, error or client cancellation.
- A revoked or rotated-out `sk-qpx-...` key is rejected with `401`.

**Roles and backward compatibility**

- Legacy `API_KEY` remains a global admin and bypasses quotas.
- With no `API_KEY` configured on a loopback bind, local requests remain
  unauthenticated and act as a local admin (historical behavior).
- A valid user key always resolves to that user, even on loopback.
- Revoked keys never fall back to local-admin trust.
- `admin` role keys can manage users through the admin API; `user` role keys
  receive `403` on management routes.

**Admin API** (same auth headers, admin role required):

| Endpoint | Method | Description |
| :--- | :---: | :--- |
| `/admin/api/users` | GET | List users, limits and active stream counts |
| `/admin/api/users` | POST | Create a user and return its key once |
| `/admin/api/users/:id` | PATCH | Update `rpm` / `concurrency` |
| `/admin/api/users/:id/rotate` | POST | Rotate and return the new key once |
| `/admin/api/users/:id` | DELETE | Revoke (row kept for audit) |

For Docker/CI bootstrap, `USER_API_KEYS` accepts comma-separated
`key:label[:rpm[:concurrency]]` entries. `USER_RATE_LIMIT_RPM` and
`USER_MAX_CONCURRENCY` set defaults for CLI/API-created users.

### 🖥️ Web Administration Dashboard

The proxy also serves an authenticated dashboard from the same process at
`http://<host>:<port>/admin` (no second server, no frontend build):

- **Sign in** with the legacy `API_KEY` or an admin-role `sk-qpx-...` key. On a
  no-key loopback install the field may be left empty (historical local-admin
  trust). The browser receives a signed `HttpOnly; SameSite=Strict` session
  cookie valid for 8 hours; the CSRF token stays in memory.
- **Overview**: accounts ready/active/on cooldown, active streams, RPM, error
  rate, average latency, memory, daily tokens and uptime. Live via SSE with an
  automatic 5-second polling fallback.
- **Accounts**: add/remove, clear one or all cooldowns, refresh headers and edit
  per-account proxies. Emails and proxy credentials are masked in every
  response.
- **Users**: create, edit RPM/concurrency, rotate and revoke keys (keys are shown
  once).
- **Models**: live catalog with context window and capabilities.
- **Settings**: allowlisted hot-applied values persisted to `.env`
  (`chat_mode`, `global_proxy_url`, `chat_request_log`, `rate_limit_requests`,
  `rate_limit_tokens`, `user_default_rpm`, `user_default_concurrency`), plus a
  **Model mappings** editor for the runtime `MODEL_MAP` aliases.
- **Logs / Audit**: recent logs with secret redaction and a durable record of
  every dashboard/API mutation.

Cookie-authenticated mutations require `x-csrf-token`; bearer clients are exempt.
The session signing secret is stored at `data/db/.admin_session_secret` (mode
`0600`), so sessions survive restarts. The TUI remains available and sees the
same state. Use TLS or a trusted tunnel before exposing the dashboard beyond
loopback; the UI shows a warning when served over plain HTTP on a non-loopback
address.

### Access from another machine (LAN)

1. In `.env`, bind all interfaces and set a strong key. A non-loopback bind is
   refused at startup when `API_KEY` is empty or still the placeholder:

   ```bash
   HOST=0.0.0.0
   API_KEY=<long-random-key>
   ```

   Clients then send `Authorization: Bearer <long-random-key>` (or use a
   spec 002 `sk-qpx-...` user key) for `/v1` and `/admin`.

2. Allow inbound TCP 3000 on private networks. On Windows, run once in an
   elevated PowerShell:

   ```powershell
   New-NetFirewallRule -DisplayName "QwenProxy 3000" -Direction Inbound `
     -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private,Domain
   ```

3. Open `http://<lan-ip>:3000/admin` from the other machine and sign in with
   `API_KEY`. The dashboard shows the TLS warning because the transport is
   plain HTTP; that is expected on a trusted LAN.

4. Keep only one proxy process bound to the port. On Windows, a `127.0.0.1`
   bind and a `0.0.0.0` bind can coexist, which silently splits local and LAN
   traffic between two instances. Check with `netstat -ano | findstr :3000`
   and stop any stale instance before starting the LAN one.

See [`specs/003-web-admin-dashboard/quickstart.md`](specs/003-web-admin-dashboard/quickstart.md)
for API examples and troubleshooting.

### Desktop tray and webview (optional)

On Windows, `qpx gui` (or `qpx --gui`) starts the proxy when needed and opens the
dashboard in a native WebView2 window. A tray icon next to the clock reopens the
window after it is closed; **Quit** in the tray menu stops the server child.

The GUI requires Node.js 24+ and the optional `@webviewjs/webview` package. It
reuses an already-running server, keeps the webview profile in
`<data>/gui-webview` (auto-login re-creates the session cookie on each start),
maps `HOST=0.0.0.0` to `127.0.0.1` for its own window, and signs in
automatically on loopback with `API_KEY` (override with
`QWEN_GUI_ADMIN_KEY`). Auto-login is loopback-only and does not change dashboard
authentication or LAN access. Standalone server binaries and Docker remain
server-only.

See [`docs/GUI.md`](docs/GUI.md) for setup and troubleshooting.


---

## 💡 Production Tips & Best Practices

1. **Use `thread-temp` for Agentic Coding Work:**  
   Coding agents generate dozens of turns and tool calls per minute. Running in `thread-temp` keeps your Qwen account clean while delivering blazing-fast ~0.6s–1.2s TTFB.
2. **Multi-Account Quota Reset (00:00 UTC):**  
   Configure 2 or more accounts. Qwen Web daily quotas reset strictly at **00:00 UTC**. When an account reaches its limit, the proxy parks it until midnight and seamlessly promotes the next healthy standby account.
3. **Profile Disk Pruning (`qpx clean`):**  
   Over time, Chromium contexts accumulate transient V8 and GPU caches. Run `qpx clean` to shrink profiles from ~300MB down to **~4.5MB per account**, while preserving cookies and authenticated sessions intact.
4. **Instant Cooldown Reset:**  
   To immediately unpark accounts on cooldown, press **`Z`** on the `[1] Status` screen or run `qpx reset`.

---

## 📦 Models & Capabilities

Models and context windows are synchronized dynamically from Qwen's live `/api/models` catalog per account. Capabilities and metadata are resolved automatically:

| Model | Context Window | Max Output | Thinking | Vision |
| :--- | :---: | :---: | :---: | :---: |
| `qwen3.8-max` | 1,000,000 | 131,072 | ✅ Yes | ✅ Yes |
| `qwen3.7-plus` | 1,000,000 | 65,536 | ✅ Yes | ✅ Yes |
| `qwen3.7-max` | 1,000,000 | 65,536 | ✅ Yes | ❌ No |
| **Fallback** | **1,048,576** | **65,536** | — | — |

### Runtime Model Mapping

Keep hardcoded client model names working when Qwen rotates its catalog. Set
`MODEL_MAP` (a seed used until the admin-managed file exists) or edit the
mapping from the dashboard's **Settings → Model mappings** card:

```dotenv
MODEL_MAP=gpt-4o=qwen3.8-max,claude-sonnet=qwen3.8-max,*=qwen3.7-plus
```

- Exact aliases are case-insensitive and win over built-in family aliases.
- `*=qwen-id` is an optional wildcard fallback for unknown model names.
- Qwen-native ids (`qwen*`, `wan*`, `z-image*`) always pass through unchanged.
- Changes are hot-reloaded from `data/model-mappings.json`; no restart needed.
- `/v1/models` lists aliases with the target's context window and capabilities.
- Invalid mappings (empty target, duplicate alias, alias chain, reserved
  `-search`/`-fast`/`-thinking` suffix, Qwen alias key) are rejected.

The admin API is `GET|PUT|DELETE /admin/api/model-mappings`; `PUT` accepts
`{"map":"alias=qwen-id,*=fallback"}` or `{"mappings":{"alias":"qwen-id"},"fallback":"qwen-id"}`.

### Synthetic Variants

- Base Model — **Auto mode** (Qwen decides whether to reason), e.g.: `qwen3.8-max`
- `-fast` — Thinking disabled for rapid generation, e.g.: `qwen3.8-max-fast`
- `-thinking` — Thinking forced ON, e.g.: `qwen3.8-max-thinking`
- `-search` — Web search ON for this request, e.g.: `qwen3.8-max-search`. Combine with a reasoning suffix in either order (`qwen3.8-max-search-thinking`, `qwen3.8-max-high-search`).

### Web Search & Citations

Web search is **opt-in per request**; requests that do not ask for it keep
`auto_search: false`. Enable it with any of:

- body `"web_search": true` (or `"webSearch": true`);
- body `"web_search_options": { ... }` (presence enables search);
- header `X-QwenProxy-Web-Search: 1` (or `true`/`on`/`yes`);
- a `-search` model suffix.

All enabling paths use Qwen's `search` chat type (`auto_search: true` plus
`chat_type`/`sub_chat_type: "search"`); `auto_search` alone with `t2t` was
live-verified to answer without searching. An explicit `false` in the body or
header wins over every enabling source.
Sources returned upstream are normalised, de-duplicated and URL-validated
(http/https only, no credentials, no local/private hosts). They appear as
OpenAI `annotations` (`type: "url_citation"`), as the documented
`search_results` array, and in the final response metadata:

```json
{ "search": { "requested": true, "ran": true, "source_count": 3 } }
```

`X-QwenProxy-Web-Search` reports `not_requested`, `requested` (streaming, before
the outcome is known), `ran`, or `no_results`. `/v1/models` exposes
`supports_search` per model; synthetic `-search` variants are not listed
separately.

### Specialized Modes (Deep Research, Web Dev, Full-Stack, Slides)

Four virtual model IDs route a normal chat-completions request to Qwen's
specialized web pipelines. They are always advertised by `/v1/models` with
`specialized_mode`, `supports_async`, `supports_citations` and
`supports_artifacts`:

| Model | Qwen pipeline | Async tasks | Citations | Artifacts |
| :--- | :--- | :---: | :---: | :---: |
| `qwen-deep-research` | Deep Research (`normal` or `advance`) | ✅ | ✅ | ✅ |
| `qwen-web-dev` | Web Dev | ✅ | ❌ | ✅ |
| `qwen-full-stack` | Web Dev with a full-stack prompt contract | ✅ | ❌ | ✅ |
| `qwen-slides` | Slides | ✅ | ❌ | ✅ |

Aliases such as `deep-research`, `web-dev`, `full-stack` and `slides` are
accepted but only the canonical IDs are listed. Synchronous use is identical to
any other model:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $QWENPROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-deep-research","messages":[{"role":"user","content":"Summarize the 2026 AI safety landscape"}]}'
```

For Deep Research, `research_mode: "advance"` (or a `-thinking` / high
`reasoning_effort` request) selects the expensive pipeline; `normal` is the
default. The `X-QwenProxy-Research-Mode` header is also accepted, and async
tasks forward it to the inner call.

Long jobs should use the async task surface so a disconnect does not lose the
work:

```bash
# Start a task
curl -X POST http://localhost:3000/v1/tasks \
  -H "Authorization: Bearer $QWENPROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-deep-research","messages":[{"role":"user","content":"Report on grid storage"}]}'
# → 202 {"id":"task_…","status":"queued","progress":0,…}

# Poll, list, cancel
curl http://localhost:3000/v1/tasks/task_…
curl "http://localhost:3000/v1/tasks?limit=20"
curl -X DELETE http://localhost:3000/v1/tasks/task_…
```

A task is a tool-free call to the same completions pipeline with `stream:false`;
the caller's credential headers (`Authorization`, `x-api-key` or
`x-goog-api-key`) are forwarded so quotas, cooldowns and account selection still
apply. Status is `queued`, `running`, `succeeded`, `failed` or
`cancelled`. `result.citations[]` lists the validated source URLs,
`result.artifacts[]` contains `{type, url, title?}` entries classified as
`report`, `pdf`, `image`, `code` or `link`, and `result.content` keeps the full
answer.

Operational notes:

- Tasks live in local SQLite (`specialized_tasks`) with a **7-day** retention.
  A restart marks `queued`/`running` tasks `failed` with `code: "interrupted"`.
- Task state is **not** shared through Redis: `DATA_SAVE_MODE=redis` still keeps
  each instance's tasks local.
- Active tasks are capped at **4 per API key** and **32 per instance** by
  default (`SPECIALIZED_TASK_MAX_ACTIVE_PER_USER`,
  `SPECIALIZED_TASK_MAX_ACTIVE`; `0` disables a cap). Exceeding a cap returns
  **429** with `code: "task_limit_exceeded"`.
- A task that exceeds its deadline (default **30 minutes**,
  `SPECIALIZED_TASK_TIMEOUT_MS`) fails with `code: "task_timeout"`; it is not
  reported as cancelled. Deep Research `advance` may need a higher value.
- Artifacts are never fetched, re-hosted or executed. Upstream-signed URLs keep
  Qwen's own expiry; download them before that TTL elapses.
- An unavailable mode returns **400** with `code: "capability_unavailable"`
  (no account configured) or `capability_unsupported` (upstream rejected the
  pipeline) instead of a generic 500.

### `reasoning_effort` Parameter

Standard OpenAI `reasoning_effort` values (`low`, `medium`, `high`) are supported:
- `low` / `none` → forces Fast mode (thinking OFF).
- `medium` / `high` / `max` → enables thinking.

---

## 🌐 Supported Endpoints

### OpenAI Compatible
| Endpoint | Method | Description |
| :--- | :---: | :--- |
| `/v1/chat/completions` | POST | Chat completions (streaming & non-streaming) |
| `/v1/chat/completions/stop` | POST | Abort an active generation |
| `/v1/chat/mode` | GET / POST | Inspect or update the global conversation mode in real time |
| `/v1/models` | GET | List available models and capabilities |
| `/v1/models/:id` | GET | Model details |
| `/v1/responses` | POST | Full OpenAI Responses API with persistent memory |
| `/v1/responses/:id` | GET / DELETE | Retrieve or delete stored response context |
| `/v1/completions` | POST | Legacy completions adapter |

### Anthropic Compatible
| Endpoint | Method | Description |
| :--- | :---: | :--- |
| `/v1/messages` | POST | Native Anthropic Messages API (Claude Code CLI, SDK) |
| `/v1/messages/count_tokens` | POST | Token counting endpoint |

### Gemini Compatible
| Endpoint | Method | Description |
| :--- | :---: | :--- |
| `/v1beta/models/{model}:generateContent` | POST | Gemini `generateContent` (text, multimodal, function calling) |
| `/v1beta/models/{model}:streamGenerateContent` | POST | Gemini SSE streaming variant |
| `/v1beta/models` | GET | Gemini-format model catalog |
| `/v1beta/models/{model}` | GET | Gemini-format model details |

Gemini routes accept `Authorization: Bearer`, `x-api-key`, `x-goog-api-key`, or
`?key=` and report unsupported translation fields through
`X-QwenProxy-Gemini-Warnings`. Gemini model families are aliased to Qwen tiers
(`gemini-*pro*` → `qwen3.8-max`, `gemini-*flash*` → `qwen3.7-plus`), while
direct Qwen ids pass through unchanged.

### Media Generation (Images & Videos)
| Endpoint | Method | Description |
| :--- | :---: | :--- |
| `/v1/images/generations` | POST | Image generation (`qwen-image-3.0-pro`, `wan2.7-image-pro`) |
| `/v1/images/edits` | POST | Image editing via multipart `image` + `prompt` (`qwen-image-3.0-pro` by default) |
| `/v1/videos/generations` | POST | Video generation (`wan3.0-video` up to 1080P, `wan2.7-t2v`) |
| `/v1/tasks/status/:taskId` | GET | Check asynchronous video task progress |

### Specialized Tasks (Deep Research, Web Dev, Full-Stack, Slides)
| Endpoint | Method | Description |
| :--- | :---: | :--- |
| `/v1/tasks` | POST | Start an asynchronous specialized-mode task |
| `/v1/tasks` | GET | List the caller's tasks (newest first) |
| `/v1/tasks/:taskId` | GET | Poll status, progress and the result |
| `/v1/tasks/:taskId` | DELETE | Cancel a queued or running task |

### Diagnostics & Monitoring
| Endpoint | Method | Description |
| :--- | :---: | :--- |
| `/health` | GET | System health check and active stream metrics |
| `/metrics` | GET | Prometheus exposition |
| `/v1/upload` | POST | Multimodal asset upload |

### API Contract & Interactive Docs
| Endpoint | Method | Description |
| :--- | :---: | :--- |
| `/openapi.json` | GET | OpenAPI 3.1 contract covering every public route |
| `/docs` | GET | Self-contained interactive API explorer (no CDN, key in memory only) |

The canonical, reviewable contract is [`docs/openapi.yaml`](docs/openapi.yaml); `/openapi.json` serves the parsed document and `/docs` renders it offline.

---

## 🛠️ CLI Commands & NPM Scripts

| Command | Description |
| :--- | :--- |
| `qpx` *(or `npm run tui`)* | Open interactive TUI dashboard with integrated server |
| `qpx start` *(or `npm start`)* | Start headless proxy server (no UI) |
| `qpx gui` *(or `qpx --gui`)* | Open the desktop tray icon and dashboard webview (optional, Node 24+) |
| `qpx sync` *(or `npm run sync`)* | Auto-configure coding agents (Claude Code, Codex, OpenCode, Cline, OMP) |
| `qpx clean` | Prune transient Chromium profile caches (~4.5MB per account) |
| `qpx clean:all` | Reclaim disk space from obsolete browser downloads (~4GB) |
| `qpx reset` | Reset rate-limit and error cooldowns in database |
| `npm run users list` | List API-key users, roles and quotas |
| `npm run users create <label> [--rpm N] [--concurrency N] [--admin]` | Create a user and print its key once |
| `npm run users limits <id\|label> <rpm> <concurrency>` | Update per-user quotas |
| `npm run users rotate <id\|label>` | Rotate a user key and print the new one once |
| `npm run users revoke <id\|label>` | Revoke a user key |
| `npm run redis:migrate` | Seed Redis from the local SQLite snapshot (optional multi-instance mode) |
| `qpx login` | Authenticate new accounts via visible browser |
| `qpx purge` | Delete remote chat history across configured accounts |
| `qpx update` | Automatically update QwenProxy to the latest version |
| `npm test` | Run complete test suite (mock & live suites) |
| `npm run typecheck` | Strict TypeScript verification (0 errors required) |

---

## 🐳 Docker Deployment

The image is published for `linux/amd64` and `linux/arm64` and includes
Chromium. Persist `/app/data` so the database, encryption key and browser
profiles survive upgrades. Images are tagged `latest`, by commit SHA and by
package version.

```yaml
services:
  qwenproxy:
    build: .
    container_name: qwenproxy
    ports:
      - "${PORT:-7936}:7936"
    env_file:
      - .env
    volumes:
      - ./data:/app/data
    restart: unless-stopped
    shm_size: "2gb"
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

### Shared persistence and multi-instance scaling (optional)

SQLite remains the default and needs no Redis. Set `DATA_SAVE_MODE=redis` only
when several instances must see the same accounts, users, logical sessions,
cooldowns, daily usage and stored Responses API state.

```bash
DATA_SAVE_MODE=redis \
REDIS_URL=redis://127.0.0.1:6379 \
ENCRYPTION_KEY="<same value on every instance>" \
npm start
```

- **Shared:** accounts (encrypted), cooldowns, users/API-key metadata, logical
  sessions and parents, daily usage, stored Responses.
- **Local to each instance:** Chromium profiles, captured Qwen auth cookies,
  personalization cache, logs and the admin audit trail.
- **Propagation:** mutations are mirrored to Redis and announced on the
  `qpx:events` stream; other instances apply them within
  `REDIS_SYNC_INTERVAL_MS` (default 1s). A session is also prefetched directly
  before a turn, so immediate continuation on another node works.
- **Credentials:** only the AES-256-GCM encrypted rows are shared. Every node
  must use the same `ENCRYPTION_KEY` (or the same `.encryption_key` file).
- **Outages:** traffic continues on local SQLite and `/health` reports
  `persistence.connected=false` / `degraded=true`. Set `REDIS_REQUIRED=true` to
  fail startup instead.
- **Migration:** seed an empty Redis from an existing deployment with
  `DATA_SAVE_MODE=redis REDIS_URL=redis://... npm run redis:migrate`. The source
  SQLite database is never modified.
- **Example:** [`docker-compose.redis.yml`](docker-compose.redis.yml) runs Redis
  plus two instances behind ports 7936/7937. Put a load balancer in front for
  true horizontal scaling.

---

## ⚖️ Disclaimer

**This software is provided "as is", without warranty of any kind, express or implied.**

- **No Affiliation:** QwenProxy is an independent open-source project and is not affiliated with, endorsed, or sponsored by Alibaba, Qwen, OpenAI, Anthropic, or any mentioned provider.
- **Educational & Personal Use:** Intended for technical research and local development. Users are solely responsible for adhering to upstream Terms of Service, managing their own credentials, and complying with applicable laws.
- **User Responsibility:** The user assumes full responsibility for account rate limits, security challenges, and content generated.

Developed and maintained by **johngbl**, built on open-source foundations originally authored by **Pedro Farias** under the [ISC License](LICENSE).

This repository is the **jul-ienfr** fork. Upstream: [johngbl/qwenproxy](https://github.com/johngbl/qwenproxy). Original: [pedrofariasx/qwenproxy](https://github.com/pedrofariasx/qwenproxy).
