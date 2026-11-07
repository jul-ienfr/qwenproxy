# Implementation Plan: Per-Account Outbound Proxy

**Branch**: `001-per-account-outbound-proxy` | **Date**: 2026-11-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-per-account-outbound-proxy/spec.md`

## Summary

Add an optional outbound proxy per Qwen account, resolved as
`account.proxy` → `PROXY_URL` → direct. Apply it to the account's Playwright
browser context and to account-scoped HTTP requests where direct fetch is still
used. Expose management through a small CLI (`npm run proxy`) and display the
masked proxy in the TUI. Proxy failures become a distinct account cooldown
reason and trigger normal failover.

## Technical Context

**Language/Version**: TypeScript 6.0 on Node.js 22+ (Node 24 in the current
environment)

**Primary Dependencies**: Hono 4, better-sqlite3 13, Patchright/Playwright 1.63,
Zod 4, tsx

**Storage**: SQLite `data/db/qwenproxy.db`; new nullable `proxy` column on
`accounts`; credentials encrypted with the existing AES-256-GCM helper

**Testing**: `node:test` via tsx; unit tests for URL parsing/resolution and
migration; typecheck gate; live proxy test optional

**Target Platform**: Windows and Linux, Docker-compatible

**Project Type**: Single TypeScript service with a TUI and HTTP API

**Performance Goals**: No measurable overhead for accounts without a proxy;
browser context launch may take longer when a proxy is configured, bounded by
the existing 30 s launch timeout

**Constraints**: No new runtime dependency for proxy support; Playwright proxy
option must be used for browser egress; direct fetch paths must not silently
bypass the proxy where the request is account-scoped

**Scale/Scope**: Up to 50+ accounts, each with an independent context; one
proxy per account

## Constitution Check

- **Upstream compatibility**: additive nullable column and optional env; existing
  accounts behave identically. PASS.
- **Browser-transport fidelity**: proxy is applied to the real browser context,
  not by replacing browser fetch with Node fetch. PASS.
- **Account isolation**: proxy is stored per account and never shared across
  contexts. PASS.
- **Spec-driven**: this plan and `tasks.md` accompany the spec. PASS.
- **Observability**: proxy failures set a distinct cooldown reason and are
  visible in logs/TUI. PASS.
- **Tests**: parser/resolver/migration unit tests plus typecheck. PASS.
- **Security**: proxy credentials encrypted and masked. PASS.
- **Simplicity**: no new runtime dependency; uses built-in URL parsing and
  Playwright's proxy option. PASS.

## Project Structure

### Documentation (this feature)

```text
specs/001-per-account-outbound-proxy/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── account-proxy-cli.md
└── tasks.md
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── accounts.ts          # QwenAccount.proxy, CRUD, env bootstrap
│   ├── database.ts          # accounts.proxy migration
│   ├── config.ts            # PROXY_URL global fallback
│   └── proxy-config.ts      # URL parsing/resolution/masking (new)
├── services/
│   └── playwright.ts        # launchPersistentContext proxy option
├── tui/
│   └── views/accounts-view.ts # masked proxy display
├── cli/
│   └── proxy.ts             # list/set/clear commands (new)
└── tests/
    └── account-proxy.test.ts # parser/resolver/migration tests (new)

package.json                 # "proxy" script
.env.example                 # PROXY_URL + QWEN_ACCOUNT_PROXIES docs
README.md                    # operational documentation
```

**Structure Decision**: Extend the existing single-project layout. No second
service or database is introduced.

## Phase 0 — Research

### Playwright per-context proxy

`browser.newContext({ proxy })` and `launchPersistentContext(profile, { proxy })`
accept `{ server, username?, password?, bypass? }`. For Chromium, the proxy is
applied to the context; the existing shared browser remains unchanged. The
current account path uses `launchPersistentContext`, so the proxy belongs in
`launchOptions` next to `userAgent`, `locale` and `viewport`.

### Proxy URL formats

Support `http://`, `https://`, `socks5://` and `socks5h://`. Parse with
`new URL()`, reject missing host/port, decode percent-encoded credentials, and
mask the password in logs. Reject `file:`, `data:` and other schemes.

### Direct fetch paths

The chat and upload paths mostly execute `fetch` inside the account page, which
inherits the context proxy. The model catalog has a Node `fetch` fallback; for
an account with a proxy, prefer the browser path or add a proxy dispatcher.
The first release will route account-scoped catalog discovery through the
browser when a proxy is configured; global catalog calls remain direct.

### Failure semantics

A proxy connection failure during context launch should mark the account
`ProxyUnavailable` for the normal cooldown window. A proxy failure during an
in-flight stream should follow the existing retry/failover policy, not be
reported as a Qwen auth error.

## Phase 1 — Design

### Data model

`accounts.proxy TEXT NULL` stores the raw proxy URL (credentials encrypted as a
whole value). `QwenAccount.proxy?: string | null`. Resolution:
`resolveAccountProxy(account.proxy)` → `config.proxy.url` → `undefined`.

### Management contract

```text
npm run proxy list
npm run proxy set <email> <proxy-url>
npm run proxy clear <email>
```

The CLI validates the URL, updates SQLite, invalidates the account cache and
closes the account's browser context so the next request relaunches with the new
proxy. The TUI displays the masked proxy in the account inspection panel.

### Browser integration

In `initPlaywrightForAccount` and the other persistent-context launch paths, add
`proxy: toPlaywrightProxy(account.proxy)` when resolved. Do not pass an empty
object. Keep the existing 30 s timeout and executable-missing retry.

### Observability

Log `proxy=<masked>` on context launch, `proxy_error` on failure, and expose the
masked proxy in the TUI account panel. Never log credentials.

## Phase 2 — Tasks

See `tasks.md`.

## Complexity Tracking

No constitution violations. The feature adds one nullable column, one small
module, one CLI command and one launch option; it does not introduce a new
runtime or service.
