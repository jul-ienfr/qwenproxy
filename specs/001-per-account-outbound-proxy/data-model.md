# Data Model: Per-Account Outbound Proxy

## Account

| Field | Type | Nullable | Notes |
| --- | --- | --- | --- |
| `id` | TEXT | no | existing primary key |
| `email` | TEXT | no | existing unique |
| `password` | TEXT | no | existing encrypted value |
| `proxy` | TEXT | yes | encrypted proxy URL when credentials are present; plain URL otherwise |
| `cooldown_until` | INTEGER | yes | existing |
| `cooldown_reason` | TEXT | yes | existing; new value `ProxyUnavailable` |
| `created_at` | TEXT | no | existing |
| `updated_at` | TEXT | no | existing |

Migration:

```sql
ALTER TABLE accounts ADD COLUMN proxy TEXT;
```

The migration is wrapped in the existing duplicate-column guard so it is
idempotent on databases that already have the column.

## QwenAccount (TypeScript)

```ts
export interface QwenAccount {
  id: string;
  email: string;
  password: string;
  proxy?: string | null;
  cooldown_until?: number;
  cooldown_reason?: string | null;
}
```

`loadAccounts()` masks `password`; it must also mask proxy credentials before
returning the object to UI/API callers.

## ProxyConfig

```ts
export interface ProxyConfig {
  server: string;          // scheme://host:port
  username?: string;
  password?: string;
  bypass?: string;
}
```

Parsing rules:

- Allowed schemes: `http`, `https`, `socks5`, `socks5h`.
- Host and port required.
- Empty path/query/fragment rejected.
- Username/password percent-decoded.
- A URL with a username but no password is valid for Playwright.

## Resolution order

1. `account.proxy` (decrypted).
2. `PROXY_URL` from the environment.
3. Direct connection.

## CLI data flow

```text
email → accounts.id → validate URL → encrypt if credentialed → UPDATE accounts
     → invalidate cache → close account context → next request relaunches
```

## Audit / observability

- Log line: `[Proxy] account=<masked email> server=<scheme://host:port> state=ready|error`.
- TUI field: `Proxy: http://host:port` or `Proxy: (direct)`.
- Cooldown reason: `ProxyUnavailable`.
