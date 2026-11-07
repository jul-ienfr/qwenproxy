# Contract: Account Proxy CLI

## Commands

```text
npm run proxy list
npm run proxy set <email> <proxy-url>
npm run proxy clear <email>
npm run proxy test <email>
```

## `list`

Outputs one row per account:

```text
<email>\t<masked-proxy-or-(direct)>\t<cooldown-reason-or-ok>
```

Exit code 0.

## `set <email> <proxy-url>`

- Validates the URL.
- Resolves the account by email (case-insensitive).
- Encrypts the URL if it contains credentials.
- Persists the value.
- Invalidates the account cache and closes the browser context.
- Prints `Proxy set for <email>: <masked-url>`.
- Exit 0 on success, 1 on invalid URL or unknown account.

Accepted schemes: `http`, `https`, `socks5`, `socks5h`.

Rejected:

```text
file:///etc/passwd
data:text/plain,hello
http://              (missing host)
http://host          (missing port)
```

## `clear <email>`

- Sets `proxy = NULL`.
- Invalidates the cache and closes the context.
- Prints `Proxy cleared for <email>`.
- Exit 0 on success, 1 on unknown account.

## `test <email>`

- Performs a lightweight TCP connect to the proxy host/port with a 5 s timeout.
- Does not send account credentials.
- Prints `reachable` or `unreachable: <reason>`.
- Exit 0 when reachable, 1 otherwise.

## Security

- Passwords are masked in all output.
- No command logs the raw proxy URL at info level.
- The database value is encrypted when credentials are present.
