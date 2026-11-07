# Feature Specification: Per-Account Outbound Proxy

**Feature Branch**: `001-per-account-outbound-proxy`

**Created**: 2026-11-07

**Status**: Implemented (live proxy verification pending)

**Input**: Gap analysis vs `Rfym21/Qwen2API`: each Qwen account can use its own
HTTP/HTTPS/SOCKS5 outbound proxy (`account.proxy` > `PROXY_URL` > direct) to
avoid IP-associated WAF bans. The current project has no per-account egress
control.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Isolate account egress (Priority: P1)

An operator assigns a different outbound proxy to each Qwen account so that
account A and account B never share the same public IP.

**Why this priority**: Qwen associates WAF reputation and rate limits with the
egress IP. The largest observed failure mode is a WAF challenge triggered on one
IP and then propagated to every account using that IP. Per-account egress is the
root-cause mitigation.

**Independent Test**: Configure two accounts with two distinct HTTP proxies,
send one completion through each, and confirm the upstream requests leave
through the expected proxy (diagnostic endpoint or proxy access log).

**Acceptance Scenarios**:

1. **Given** account A has `proxy = http://proxy-a:8080` and account B has no
   proxy, **When** a request is routed to A then B, **Then** A's browser and HTTP
   traffic use proxy A and B's traffic uses the direct connection.
2. **Given** a global `PROXY_URL` and an account-level proxy, **When** the
   account is selected, **Then** the account-level proxy wins.
3. **Given** an account proxy that is unreachable, **When** the account is
   selected, **Then** the request fails over to the next healthy account and the
   failing account is cooled down with reason `ProxyUnavailable`.

---

### User Story 2 - Manage proxies without editing files (Priority: P2)

An operator sets, updates or clears an account proxy from the TUI (and later the
web dashboard) without restarting the proxy.

**Why this priority**: Proxy rotation is an operational task; requiring a
process restart makes incident response slow.

**Independent Test**: Change an account proxy from the management surface,
restart only that account's browser context, and verify the next request uses
the new proxy.

**Acceptance Scenarios**:

1. **Given** an account with no proxy, **When** the operator saves a valid proxy
   URL, **Then** the account is marked for context recreation and the next
   request uses it.
2. **Given** an account with a proxy, **When** the operator clears it, **Then**
   the next request uses the global fallback or direct connection.

---

### User Story 3 - Diagnose egress safely (Priority: P3)

An operator can see which proxy an account uses and whether it is healthy,
without exposing proxy credentials in logs or API responses.

**Why this priority**: Misconfigured proxies are otherwise indistinguishable
from Qwen outages.

**Independent Test**: Query the account diagnostics and confirm the proxy is
reported as a masked URL plus a health state.

**Acceptance Scenarios**:

1. **Given** a proxy URL containing a username and password, **When** the
   account list is returned, **Then** the password is redacted.
2. **Given** a proxy health check fails, **When** the account is inspected,
   **Then** the state is `unhealthy` with a timestamped reason.

### Edge Cases

- Proxy URL uses `socks5://` or `socks5h://`; DNS resolution must follow the
  protocol's expected behavior.
- Proxy URL contains percent-encoded credentials and special characters.
- Proxy is reachable but returns HTTP 407; the account must not be marked as a
  Qwen credential failure.
- A browser context is already open when the proxy changes; the old context must
  be closed before the new one is used.
- The global proxy is set but an account explicitly requests direct egress.
- Docker deployment loses the proxy environment; account-level config must still
  work.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Account records MUST support an optional outbound proxy URL.
- **FR-002**: The system MUST support `http`, `https`, `socks5` and `socks5h`
  proxy schemes.
- **FR-003**: Resolution order MUST be account proxy, then global `PROXY_URL`,
  then direct.
- **FR-004**: The proxy MUST be applied to the account's browser context and to
  every direct HTTP request made on behalf of that account.
- **FR-005**: Changing or clearing an account proxy MUST invalidate that
  account's browser context without affecting other accounts.
- **FR-006**: Proxy connection failures MUST trigger account cooldown with a
  distinct reason and normal failover, not a generic Qwen auth error.
- **FR-007**: Proxy credentials MUST be encrypted at rest like account passwords
  and MUST be redacted in logs, API responses and TUI screens.
- **FR-008**: A diagnostic surface MUST report proxy presence, protocol, host,
  port and health without revealing credentials.
- **FR-009**: Proxy configuration MUST be settable from the TUI and via the admin
  API when the web dashboard exists.
- **FR-010**: Existing accounts without a proxy MUST keep the current behavior.

### Key Entities

- **Account**: existing Qwen account; gains an optional proxy reference.
- **ProxyConfig**: scheme, host, port, optional credentials, health state and
  last check timestamp.
- **AccountEvent**: audit record for proxy changes and proxy failures.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Two accounts configured with different proxies produce different
  observed egress IPs in 100% of diagnostic checks.
- **SC-002**: A dead proxy causes failover within one request and does not block
  other accounts.
- **SC-003**: No proxy password appears in logs, API responses or test fixtures.
- **SC-004**: Existing accounts without proxies pass the current regression
  suite unchanged.

## Assumptions

- The browser engine supports per-context proxy configuration; the current
  Patchright/Playwright stack does.
- Operators provide their own proxies; the project does not ship proxy service.
- Proxy health checks may be active (connect + HTTP probe) or passive (first
  request failure); the plan will choose the lower-risk option.
- The web dashboard from spec 003 will expose the same fields later; the TUI is
  the first management surface.
