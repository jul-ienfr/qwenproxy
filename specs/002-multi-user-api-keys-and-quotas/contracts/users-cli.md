# Contract: Users CLI

## Commands

```text
npm run users list
npm run users create <label> [--rpm N] [--concurrency N] [--admin]
npm run users revoke <id|label>
npm run users rotate <id|label>
npm run users limits <id|label> <rpm> <concurrency>
```

## `list`

```text
<id>\t<label>\t<role>\t<prefix>...\trpm=<n>\tconcurrency=<n>\t<active|revoked>
```

## `create`

- Generates `sk-qpx-<base64url>`.
- Stores only the SHA-256 hash and the first 12 characters.
- Prints the plaintext key exactly once:

```text
Created user <id> (<label>)
API key: sk-qpx-...
Store it now; it cannot be displayed again.
```

## `revoke`

- Sets `revoked_at`.
- Prints the affected user id and label.
- Exit 1 if not found or already revoked.

## `rotate`

- Generates a new key, replaces the hash/prefix, clears `revoked_at`.
- Prints the new key once.

## `limits`

- Sets RPM and max concurrency. `0 0` means unlimited.
- Validates non-negative integers.

## Exit codes

0 success, 1 validation/not-found/error.

## Security

Never print a stored key. Never log the key in errors. The CLI may run while the
server is live; the next request reads the updated row.
