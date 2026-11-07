# Quickstart: Per-Account Outbound Proxy

## 1. Set a global fallback (optional)

```env
PROXY_URL=http://proxy.example.com:8080
```

Every account without its own proxy uses this value.

## 2. Set an account proxy

```bash
npm run proxy set account-a@example.com http://user:pass@proxy-a.example.com:8080
npm run proxy set account-b@example.com socks5://proxy-b.example.com:1080
```

The CLI validates the URL, encrypts credentials, updates SQLite and closes the
account browser context. The next request relaunches it with the proxy.

## 3. Inspect

```bash
npm run proxy list
```

Output masks passwords:

```text
account-a@example.com  http://user:***@proxy-a.example.com:8080
account-b@example.com  socks5://proxy-b.example.com:1080
account-c@example.com  (direct / PROXY_URL)
```

## 4. Clear

```bash
npm run proxy clear account-a@example.com
```

The account falls back to `PROXY_URL` or direct.

## 5. Verify egress

Use a proxy access log or an external IP echo service from the same proxy. The
proxy itself does not expose an egress-IP endpoint; a diagnostic can be added
later without changing the account contract.

## 6. Failure behavior

- Unreachable proxy at context launch → account cooldown reason
  `ProxyUnavailable`, request fails over to the next account.
- Proxy drops mid-stream → existing retry/failover policy; the account is not
  marked as a Qwen credential failure.
- Invalid URL → CLI exits non-zero and prints the accepted schemes.

## 7. Docker

Set `PROXY_URL` in the container environment, or set per-account proxies through
the CLI/TUI. The proxy is used by Chromium inside the container; no host
networking change is required.
