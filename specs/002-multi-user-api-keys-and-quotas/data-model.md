# Data Model: Multi-User API Keys and Quotas

## User

| Field | Type | Nullable | Notes |
| --- | --- | --- | --- |
| `id` | TEXT | no | UUID primary key |
| `label` | TEXT | no | human-readable owner/client name |
| `api_key_hash` | TEXT | no | SHA-256 hex digest, unique |
| `api_key_prefix` | TEXT | no | first 12 characters for display |
| `role` | TEXT | no | `admin` or `user` |
| `rate_limit_rpm` | INTEGER | no | 0 = unlimited |
| `max_concurrency` | INTEGER | no | 0 = unlimited |
| `created_at` | TEXT | no | ISO/SQLite datetime |
| `updated_at` | TEXT | no | ISO/SQLite datetime |
| `revoked_at` | TEXT | yes | non-null means authentication fails |

Indexes: unique `api_key_hash`, index `label`.

## UserIdentity (request context)

```ts
export interface UserIdentity {
  id: string;
  label: string;
  role: "admin" | "user";
  rateLimitRpm: number;
  maxConcurrency: number;
  legacy: boolean;
}
```

Legacy identities: `local-admin` (no key, loopback) and `global-admin` (API_KEY).
They are not persisted and bypass quotas.

## Quota state

```ts
interface UserQuotaState {
  requestTimestamps: number[]; // last 60s, pruned on check
  activeStreams: number;
}
```

## Lifecycle

1. `POST /admin/api/users` or `npm run users create` generates a key, hashes it,
   inserts the row, and returns the plaintext key exactly once.
2. `rotate` replaces `api_key_hash`/prefix and returns the new plaintext key.
3. `revoke` sets `revoked_at`; the next request with that key receives 401.
4. `limits` updates RPM/concurrency; the next request uses the new values.

## Audit

- Key creation/rotation/revocation is logged with the user id and label, never
  the key.
- 429 responses include the user id, limit kind and `Retry-After`.
