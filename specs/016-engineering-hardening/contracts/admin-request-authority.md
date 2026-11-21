# Contract: Admin Request Authority

**Feature**: 016-engineering-hardening · **Story**: US1 · **Finding**: S1

**Purpose**: define the observable behaviour of the inbound authority check that
closes the DNS-rebinding takeover. These are invariants, not implementation notes.
Every invariant maps to an assertion in `src/tests/admin-request-authority.test.ts`
and must fail on the pre-fix tree where marked.

## Scope

Applies to every HTTP request reaching the listener, evaluated **before** any
identity resolution (`resolveIdentity`), before `authenticateAdminRequest`, and
before any route handler. It is not an admin-only middleware: an untrusted
authority is refused for the API surface too, because the same rebinding primitive
reads `/admin/api/*` GETs and drives `/v1/*` with the operator's ambient trust.

## Invariants

### I1 — Untrusted authority is refused regardless of Origin

A request whose `Host` authority is not in the trusted set is rejected with `403`
and produces **no state change**, in all four combinations:

| `Origin` | `Host` | Result |
| --- | --- | --- |
| absent | untrusted | reject |
| present, equals Host (rebinding) | untrusted | reject |
| present, differs from Host | untrusted | reject |
| `null` or malformed | untrusted | reject |

**Fails before the fix**: rows 1 and 2. Row 1 is accepted today because
`admin/auth.ts:139` returns "allowed" when `Origin` is absent; row 2 is accepted
because `:153-157` only compares the two hosts, which agree.

### I2 — Trusted authority preserves every existing behaviour

With a trusted `Host`, all current outcomes are unchanged: the no-key loopback
admin path, bearer-key auth, cookie sessions with CSRF, login throttling, the
static dashboard, and the existing cross-origin rejection when `Origin` differs
from `Host`.

**Must not regress**: `admin-dashboard.test.ts` (16 assertions),
`admin-session.test.ts` (8), `login-throttle.test.ts`, `local-auth.test.ts`,
`cors-headers.test.ts`, `user-auth.test.ts`, `tenant-isolation.test.ts`.

### I3 — The trusted set is derived, not configured, for the default install

With no operator configuration the set contains the loopback authorities
(`127.0.0.1`, `localhost`, `::1`) on the listening port, plus the configured bound
host when it is a concrete address. A default install therefore needs **no new
environment variable** to keep working.

### I4 — Explicit configuration extends the set, and only explicitly

A declared reverse-proxy hostname becomes trusted. Nothing else does. The set is
never widened by a request header: `X-Forwarded-Host`, `X-Forwarded-For`,
`Forwarded`, `Referer` and `Origin` are **not** inputs to the trust decision.

**Rationale**: the existing login throttle deliberately keys on the socket address
and ignores forwarded headers (`admin/app.ts:81-90`); the authority check must not
reintroduce header-derived trust through a different door.

### I5 — Authority normalisation is exact and total

Comparison is case-insensitive and treats these as equivalent to their canonical
form: an explicit default port versus an implicit one, a bracketed IPv6 literal
versus its bare form, and surrounding whitespace. It does **not** treat these as
equivalent: a different port, a subdomain of a trusted host, a trailing-dot
variant not declared, a userinfo component, or a host that merely contains a
trusted host as a substring.

### I6 — The no-key legacy path additionally requires a loopback peer

When no `API_KEY` is configured, `LOCAL_ADMIN_IDENTITY` is granted only if the
peer socket address is loopback **and** the authority is trusted. Headers alone
never grant it. A non-loopback peer with a trusted authority must fall back to the
normal credential requirement.

### I7 — Defence in depth is retained

`rejectCrossOriginMutation` and `validateCsrf` remain in place and remain
effective. Removing or weakening them is a contract violation even though the
authority check now runs first: the two mechanisms cover different threats
(rebinding versus genuine cross-origin CSRF).

### I8 — Adapter self-fetches keep working

Requests originating from `getInternalOrigin()` carry a loopback or bound-host
authority and are therefore trusted. Every protocol adapter that self-fetches
(`routes/anthropic`, `routes/gemini`, `routes/responses`, `routes/completions`,
`routes/specialized-tasks`) continues to function without configuration.

### I9 — Rejection is observable and non-leaking

Each rejection increments a counter exposed on `/metrics` and emits one structured
log line at warn level containing the rejected authority and the request method.
It contains **no** request body, no credential, no cookie and no query string.
The response body carries a stable, non-enumerating message; it does not list the
trusted set.

### I10 — Wildcard bind degrades safely

With a wildcard bind (`0.0.0.0` or `::`) there is no single bound hostname. The
trusted set is then loopback plus any explicitly declared host. The existing
requirement that a non-loopback bind must have a key is unchanged
(`local-auth.ts:37-44`), so this case never grants no-key admin over the network.

## Test mapping

| Invariant | Assertion |
| --- | --- |
| I1 | rebinding matrix: 4 Origin variants × untrusted Host, assert 403 + unchanged settings |
| I2 | run the seven existing suites unmodified |
| I3 | boot with no config, assert loopback dashboard works and no new env var is read |
| I4 | declare a proxy host, assert it works; send `X-Forwarded-Host` for an undeclared host, assert reject |
| I5 | normalisation table: equivalent forms accepted, non-equivalent forms rejected |
| I6 | trusted authority + non-loopback peer + no key → not admin |
| I7 | trusted authority + differing Origin on a mutation → still 403; cookie mutation without CSRF → still 403 |
| I8 | adapter self-fetch smoke through each of the five adapters |
| I9 | counter increments; log line contains authority and method, contains no body/credential |
| I10 | wildcard bind: loopback trusted, undeclared host rejected, key requirement intact |

## Non-goals

- No change to CORS policy, to the CSRF token format, or to the session cookie
  attributes.
- No new authentication factor and no mandatory `API_KEY` for loopback use.
- No inference of trust from TLS termination; a proxy deployment declares its
  hostname explicitly (I4).
