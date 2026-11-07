# Phase 0 Research: Per-Account Outbound Proxy

## Decision: Playwright context proxy

Use the `proxy` option on `launchPersistentContext` for each account context.

**Rationale**: The current browser transport executes Qwen fetches inside the
account page. A context-level proxy therefore covers chat, personalization,
header capture and OSS calls without rewriting each fetch. `browser.newContext`
has the same option if a future path creates non-persistent contexts.

**Alternatives considered**:
- Global `HTTP_PROXY` environment: affects every account, cannot isolate egress.
- Launch one Chromium process per account with `--proxy-server`: heavier and
  duplicates the shared-browser memory win.
- Node `undici` ProxyAgent for every call: does not cover in-page fetch and would
  break the browser anti-bot path.

## Decision: URL validation

Parse with `new URL()` and allow only `http:`, `https:`, `socks5:` and
`socks5h:`. Require a hostname and an explicit port. Decode credentials with
`decodeURIComponent` and map them to Playwright's `username`/`password`.

**Rationale**: Playwright accepts a server string plus optional credentials; a
single validated parser avoids duplicated ad-hoc string handling.

## Decision: Storage and encryption

Store the proxy URL in a nullable `accounts.proxy` column. If the URL contains
credentials, encrypt the whole value with the existing `encrypt()` helper before
writing and decrypt it only when building the launch options.

**Rationale**: Proxy passwords are credentials; the existing AES-256-GCM store
already protects account passwords, and the same key lifecycle applies.

## Decision: Direct fetch fallback

Prefer the browser path for account-scoped requests. For the model catalog's
Node fetch fallback, route through the browser when the account has a proxy.
Global catalog calls without an account remain direct.

**Rationale**: The browser path already inherits the proxy and anti-bot headers.
Adding a second proxy stack for Node fetch increases maintenance without
covering in-page requests.

## Decision: Failure reason

Introduce `ProxyUnavailable` as a cooldown reason. A launch failure caused by the
proxy is recorded as this reason; an in-flight proxy failure follows the normal
retry/failover policy.

**Rationale**: Operators must distinguish "Qwen rejected the account" from "the
network path is down"; the existing cooldown table already supports a reason
string.

## Open questions resolved

- Does the shared browser need to restart when one account proxy changes? No;
  the account context is recreated, the shared browser stays.
- Should the proxy apply to the admin dashboard? No; it is account egress only.
- Should health checks be active? Start passive; a failed context launch is the
  first health signal. An active probe can be added later.
