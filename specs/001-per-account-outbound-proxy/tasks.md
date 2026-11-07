# Tasks: Per-Account Outbound Proxy

**Feature**: `001-per-account-outbound-proxy`
**Plan**: [plan.md](plan.md)
**Spec**: [spec.md](spec.md)

## Phase 1 — Foundation

- [ ] T001 Add `proxy-config.ts` with URL parsing, scheme allowlist, credential
  decoding, Playwright proxy object conversion and masking.
- [ ] T002 Add `proxy` to `QwenAccount` in `src/core/accounts.ts` and include it in
  cached reads/writes.
- [ ] T003 Add the nullable `accounts.proxy` migration in
  `src/core/database.ts` with the duplicate-column guard.
- [ ] T004 Add `PROXY_URL` to `src/core/config.ts` and `.env.example`.
- [ ] T005 Add `QWEN_ACCOUNT_PROXIES` env bootstrap parsing
  (`email=url,email=url`) to `src/core/accounts.ts`.

## Phase 2 — Tests First

- [ ] T006 Add `src/tests/account-proxy.test.ts` for:
  accepted/rejected schemes, credential decode, masking, resolution order,
  migration idempotency.
- [ ] T007 Add a test that `loadAccounts()` masks both password and proxy
  credentials.
- [ ] T008 Add a test for `QWEN_ACCOUNT_PROXIES` parsing and duplicate handling.

## Phase 3 — Browser Integration

- [ ] T009 In `src/services/playwright.ts`, resolve the account proxy and add
  `proxy` to each `launchPersistentContext` options object.
- [ ] T010 On proxy-related launch failure, mark the account cooldown with
  `ProxyUnavailable` and preserve the original error message in logs.
- [ ] T011 Ensure account context recreation after a proxy change closes only
  that account's context, never the shared browser.
- [ ] T012 Route account-scoped model catalog discovery through the browser path
  when a proxy is configured; keep global catalog calls direct.

## Phase 4 — Management

- [ ] T013 Add `src/cli/proxy.ts` with `list`, `set`, `clear`, `test`.
- [ ] T014 Add `"proxy": "tsx src/cli/proxy.ts"` to `package.json`.
- [ ] T015 Display the masked proxy in the TUI account inspection panel.
- [ ] T016 Add a TUI hint or shortcut that points to `npm run proxy` for edits
  (full TUI editing is a follow-up; the CLI is the first management surface).
- [ ] T017 Document proxy operations in `README.md`.

## Phase 5 — Verification

- [ ] T018 Run `npm run typecheck`.
- [ ] T019 Run the new unit tests.
- [ ] T020 Live check with one account and one HTTP proxy: confirm the browser
  context launches and a small completion succeeds.
- [ ] T021 Live check with an invalid proxy: confirm `ProxyUnavailable` cooldown
  and failover to a healthy account.
- [ ] T022 Update `specs/001-per-account-outbound-proxy/quickstart.md` if the
  implementation deviates from the contract.

## Dependencies

- T002 before T003/T005/T009.
- T006 before T009 (test-first).
- T013 depends on T001/T002.
- T015 depends on T002 and the TUI status payload.
- T020/T021 require a real proxy endpoint supplied by the operator.

## Out of scope

- Editing proxies from the web dashboard (spec 003 will consume the same API).
- Active proxy health probes beyond the CLI `test` command.
- Per-request proxy override headers.
