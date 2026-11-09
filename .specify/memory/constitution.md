# QwenProxy Constitution

## Core Principles

### I. Upstream Compatibility and Attribution (NON-NEGOTIABLE)

QwenProxy is a fork of `johngbl/qwenproxy`, itself derived from
`pedrofariasx/qwenproxy` by Pedro Farias. Every change MUST preserve the
existing public API surface (`/v1/chat/completions`, `/v1/messages`,
`/v1/responses`, `/v1/models`, `/v1/upload`, `/v1/images/*`, `/v1/videos/*`,
`/health`, `/metrics`) unless the specification explicitly declares a breaking
change. Upstream copyright notices, the `NOTICE` file and the README
attribution MUST remain intact. New features MUST be documented as fork-local
extensions, not as claims of original authorship.

### II. Browser-Transport Fidelity

Qwen Web requests MUST continue to run inside a real, authenticated browser
context whenever Qwen's WAF, Baxia headers, cookies or fingerprints are required.
Direct Node HTTP is permitted only for endpoints already proven safe in the
current codebase. Any new transport path MUST be validated against a live Qwen
account and MUST degrade to the browser path instead of silently bypassing
anti-bot protections.

### III. Account Isolation and Credential Safety

Each Qwen account MUST keep its own browser context, cookies, fingerprint,
cooldowns and usage counters. Credentials MUST be encrypted at rest with the
existing AES-256-GCM mechanism; plaintext account exports MUST never be
committed, logged or shipped. Per-account failures MUST NOT leak data, sessions
or cooldowns into another account. New account-level settings (for example
outbound proxies) MUST follow the same isolation rule.

### IV. Spec-Driven Changes

Every non-trivial feature starts with a Spec Kit specification under
`specs/<number>-<slug>/spec.md`, followed by a plan and tasks when the feature
is scheduled. Specifications describe user outcomes, functional requirements,
edge cases and measurable success criteria before implementation details.
Bug fixes may use the bug-fix process, but MUST still record the symptom,
cause, fix and verification.

### V. Observability and Operability

Every feature that changes request handling, account selection, persistence or
configuration MUST expose enough evidence to operate it: structured logs without
secrets, `/health` and `/metrics` continuity, account cooldown reasons, and a
clear failure mode. Operators MUST be able to diagnose a failed request from
logs and status surfaces without attaching a debugger.

### VI. Test-First and Regression Gates

Protocol translations, streaming parsers, tool-call handling, account failover,
credential storage and new API surfaces MUST have automated tests. The existing
`npm run typecheck` gate MUST pass. New endpoints MUST include contract tests for
success, upstream error and malformed input. Tests MUST not require live Qwen
credentials unless they are explicitly marked live tests.

### VII. Security and Least Privilege

API authentication MUST be explicit, rate-limited and separated by role where
multi-user support exists. Secrets MUST come from environment variables or
encrypted storage, never from committed files. Administrative surfaces MUST be
authenticated. New outbound network destinations (proxies, OSS, webhooks) MUST
be validated or allowlisted.

### VIII. Simplicity and Backward Compatibility

Prefer extending the existing Hono + TypeScript + SQLite + Playwright
architecture over introducing a second runtime, database or protocol stack.
New configuration MUST be optional and default to the current behavior.
Existing clients, scripts and Docker volumes MUST keep working after an upgrade.

### IX. Cross-Platform by Default (NON-NEGOTIABLE)

Every runtime feature, command, script, service and distribution artifact MUST
work on Windows 10/11, macOS and Linux. Platform-specific behavior MUST be
isolated behind small adapters and MUST fail with an actionable message when a
capability is unavailable. Code MUST use `node:path` instead of hard-coded path
separators, handle CRLF and LF, avoid Unix-only shell commands and signals in
shared paths, and keep native dependencies optional. A change that touches
OS-specific code MUST be verified on at least one non-primary platform or
covered by a platform-agnostic test. The optional desktop GUI MAY rely on native
tray/WebView2 capabilities, but an unsupported or missing backend MUST degrade
gracefully without breaking the CLI, HTTP server, Docker image or standalone
binaries.

### X. Silent, Non-Intrusive Operation (NON-NEGOTIABLE)

Background work MUST NOT flash or open console windows (cmd.exe, MS-DOS prompt,
PowerShell, terminal) on any platform. Server children, GUI helpers, updaters,
installers, login flows and scheduled tasks MUST be spawned hidden
(`windowsHide: true` on Windows), with `shell: false` unless a shell is strictly
required, MUST prefer the Node entrypoint over `.bat`/`.cmd` wrappers, and MUST
send output to pipes or log files instead of inheriting a console. A console
window is allowed only when the user explicitly runs an interactive CLI command.
GUI windows MUST open only in response to an explicit user action or an explicit
autostart/opt-in setting; health probes, retries and background refreshes MUST
never raise windows.

### XI. Engineering Excellence (NON-NEGOTIABLE)

All changes MUST uphold five standing qualities:

- **Reliability**: fail closed, bound every retry, timeout and buffer, make
  startup and shutdown idempotent, handle rejections and partial failures, and
  test failure paths.
- **Performance**: never block the event loop, stream large payloads, bound
  queues, respect concurrency and memory budgets, and justify added per-request
  work.
- **Quality**: typecheck, automated tests and documentation for every behavior
  change; consistent error messages; no dead code or debug leftovers.
- **Modularity**: single-responsibility modules, explicit typed interfaces,
  dependency injection for testability, and optional capabilities isolated and
  disabled by default.
- **Maintainability**: small reviewable diffs, no duplicated logic, named
  constants, comments only for non-obvious decisions, specs and docs updated with
  the behavior, and backward compatibility preserved.

## Additional Constraints

- Platforms: Windows 10/11, macOS and Linux. Node.js 22+ is the shared runtime;
  GUI-only features may require Node.js 24+.
- Background processes: hidden spawn (`windowsHide: true`) with pipe/file
  logging; no console window for non-interactive work.
- Persistence: SQLite via `better-sqlite3` remains the default; Redis is an
  optional adapter, never a mandatory dependency.
- Browser: Patchright/Playwright with a shared Chromium instance and isolated
  `BrowserContext` per account.
- Packaging: Docker remains the primary deployment artifact; native binaries and
  multi-arch images are optional distribution improvements and MUST stay
  cross-platform.
- GUI: optional native shell, cross-platform where its backend supports it, with
  clear fallback elsewhere.
- Public protocol compatibility: OpenAI Chat Completions, OpenAI Responses,
  Anthropic Messages, and (when specified) Gemini `generateContent`.
- No new mandatory cloud service. Optional integrations must fail closed and
  leave the local proxy usable.

## Development Workflow

1. Write or update the feature specification in `specs/<number>-<slug>/spec.md`.
2. Resolve ambiguities with the clarify step before planning.
3. Produce `plan.md` and `tasks.md` for scheduled work.
4. Implement in small, reviewable commits; preserve unrelated configuration.
5. Check cross-platform impact (paths, shell usage, signals, line endings,
   native dependencies) and validate OS-specific changes on a second platform
   when possible.
6. Confirm that background commands open no console window and no unexpected GUI
   window, and that any visible window is user-initiated.
7. Run `npm run typecheck` and the relevant tests before committing.
8. Update `README.md`, `.env.example` and `NOTICE` when public behavior or
   provenance changes.
9. Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`,
   `test:`, `chore:`).

## Governance

This constitution supersedes ad-hoc implementation preferences. Amendments
require a documented rationale, a review of affected specifications, and a
migration note when behavior changes. Feature specifications MUST declare any
conflict with these principles; unresolved conflicts block implementation.
The constitution is versioned below and reviewed whenever a new protocol,
runtime or credential store is introduced.

### Amendment Record

- **1.1.0 (2026-11-09)**: Added Principles IX (Cross-Platform by Default),
  X (Silent, Non-Intrusive Operation) and XI (Engineering Excellence).
  Rationale: the operator requires the whole system to remain multi-OS, to never
  open spurious console or GUI windows, and to meet standing reliability,
  performance, quality, modularity and maintainability expectations. Affected
  specifications: all existing and future specs; no data migration. The optional
  desktop GUI (spec 014) keeps its Windows-first native backend but MUST keep
  degrading gracefully on unsupported platforms.

**Version**: 1.1.0 | **Ratified**: 2026-11-07 | **Last Amended**: 2026-11-09
