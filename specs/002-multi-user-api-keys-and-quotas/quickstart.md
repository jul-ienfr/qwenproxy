# Quickstart: Multi-User API Keys and Quotas

## 1. Bootstrap an admin key

If `API_KEY` is already set, it is the admin key. Otherwise, on a loopback bind,
the local operator is an implicit admin and can create users without a key.

```bash
npm run users create alice --rpm 120 --concurrency 4
```

Copy the printed `sk-qpx-...` key; it is shown once.

## 2. Use the key

```bash
curl http://127.0.0.1:3000/v1/models \
  -H "Authorization: Bearer sk-qpx-..."
```

## 3. Set limits

```bash
npm run users limits alice 60 2
npm run users list
```

`0 0` means unlimited.

## 4. Rotate and revoke

```bash
npm run users rotate alice
npm run users revoke alice
```

The old key stops working on the next request; the row remains for audit.

## 5. Environment bootstrap

```env
USER_API_KEYS=sk-key-1:alice:120:4,sk-key-2:bob:60:2
USER_RATE_LIMIT_RPM=120
USER_MAX_CONCURRENCY=4
```

The env keys are hashed at startup. They are convenient for Docker/CI; the CLI
and admin API are the normal management surfaces.

## 6. Quota responses

Exceeded RPM or concurrency:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 12
```

The body uses the existing OpenAI error envelope. No account slot or Qwen
request is consumed.

## 7. Backward compatibility

- No key + loopback: local admin, no auth, no quota.
- `API_KEY` set: global admin, no quota.
- Existing clients keep working until a user key is required.
