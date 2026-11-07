# Data Model: Authenticated Web Administration Dashboard

**Feature**: `003-web-admin-dashboard`

## New Persistent Table

### `admin_audit`

| Column | Type | Constraints | Notes |
| --- | --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Ordering key |
| `actor` | TEXT | NOT NULL | Session label, API-key label, or `unknown` |
| `action` | TEXT | NOT NULL | e.g. `account.create`, `user.key.rotate` |
| `target` | TEXT | NOT NULL, default `''` | Account id, user id, setting keys |
| `result` | TEXT | NOT NULL, default `'ok'` | `ok` or `error` |
| `details` | TEXT | NULL | Truncated JSON; never secrets |
| `created_at` | TEXT | NOT NULL, default `datetime('now')` | UTC timestamp |

Index: `idx_admin_audit_created` on `created_at`.

Created in `src/core/database.ts` via `CREATE TABLE IF NOT EXISTS`, so existing
databases migrate on startup.

## Ephemeral Structures

### `AdminSessionPayload` (signed cookie `qpx_admin`)

| Field | Type | Notes |
| --- | --- | --- |
| `sub` | string | User id or `local-admin`/`global-admin` |
| `label` | string | Display label |
| `role` | `admin` \| `user` | Only `admin` accepted |
| `csrf` | string | Random base64url token |
| `iat` | number | Issued-at, seconds |
| `exp` | number | Expiry, seconds; default `iat + 28800` |

Wire format: `base64url(JSON).HMAC-SHA256(base64url(JSON))`.

Signing secret: `data/db/.admin_session_secret` (32 random bytes, hex, mode
`0600`). Generated lazily and cached in memory.

### `AccountSnapshot`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Account UUID |
| `email` | string | Masked, e.g. `jo***@example.com` |
| `proxy` | string \| null | Already masked by `loadAccounts()` |
| `cooldown_until` | number | Epoch ms (0 when none) |
| `cooldown_reason` | string \| null | Only when active |
| `cooldown_remaining_ms` | number | Computed |
| `headers_ready` | boolean | From account manager |
| `active` | boolean | Playwright context active |

### `OverviewSnapshot`

```text
{
  status: "healthy" | "degraded" | "unhealthy",
  version, uptimeSec, timestamp, chatMode,
  accounts: { total, ready, active, cooldown, list[] },
  streams: { active, errors },
  requests: { total, cumulativeErrors, rpm, errorsPerMinute, errorRatePercent },
  latency: { avgMs },
  memory: { rssMb, heapUsedMb, heapLimitMb, heapUsagePercent },
  usage: { dateUtc, totalPromptTokens, totalCompletionTokens, totalWeightedTokens,
           totalTokens, totalTurns, poolCapacityTokens, poolUsagePercent },
  users: { total, active, admins }
}
```

Request/error windows are process-local arrays of timestamps pruned to the last
60 seconds (bounded at 20,000 samples).

### `SettingDescriptor`

| Field | Type | Notes |
| --- | --- | --- |
| `key` | string | Allowlisted key |
| `label` | string | UI label |
| `group` | string | UI grouping |
| `type` | `string` \| `number` \| `boolean` \| `select` | Input type |
| `value` | string \| number \| boolean | Current runtime value |
| `options` | string[]? | For `select` |
| `restartRequired` | boolean | All current entries are `false` |
| `help` | string | Description |

Allowlist: `chat_mode`, `global_proxy_url`, `chat_request_log`,
`rate_limit_requests`, `rate_limit_tokens`, `user_default_rpm`,
`user_default_concurrency`.

## Relationships

- `AdminSessionPayload.sub` references a `users.id` for DB-backed identities, or
  the synthetic `local-admin`/`global-admin` ids.
- `admin_audit.target` references account ids or user ids by convention only
  (no foreign keys, so deleted targets keep their audit trail).
- Overview snapshots are computed, never persisted.

## Security Invariants

1. No table stores plaintext API keys, passwords or proxy credentials (spec 002
   already hashes keys and encrypts account passwords).
2. Session payloads contain no credential, only an id/label/role/CSRF token.
3. Audit `details` are JSON truncated to 2,000 characters and must not include
   passwords, API keys or proxy credentials.
4. Browser-facing account emails are masked beyond the first two local-part
   characters; proxy URLs are masked by the existing helper.
