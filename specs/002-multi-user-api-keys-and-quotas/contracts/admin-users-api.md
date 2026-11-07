# Contract: Admin Users API

Base path: `/admin/api/users`
Auth: `Authorization: Bearer <admin key>` or `x-api-key: <admin key>`.
Role: `admin` required. Legacy `API_KEY` and loopback local-admin qualify.

## `GET /admin/api/users`

```json
{
  "users": [
    {
      "id": "uuid",
      "label": "team-a",
      "role": "user",
      "prefix": "sk-qpx-abcd",
      "rate_limit_rpm": 60,
      "max_concurrency": 2,
      "created_at": "...",
      "updated_at": "...",
      "revoked_at": null,
      "active_streams": 1
    }
  ]
}
```

`active_streams` is process-local and may differ across instances.

## `POST /admin/api/users`

Request:

```json
{ "label": "team-a", "role": "user", "rpm": 60, "concurrency": 2 }
```

Response 201:

```json
{
  "user": { "id": "...", "label": "team-a", "role": "user", "prefix": "sk-qpx-abcd" },
  "api_key": "sk-qpx-..."
}
```

The `api_key` is returned exactly once.

## `PATCH /admin/api/users/{id}`

Request: `{ "rpm": 120, "concurrency": 4 }` (both optional).
Response: updated user without the key.

## `POST /admin/api/users/{id}/rotate`

Response: `{ "user": {...}, "api_key": "sk-qpx-..." }`; old key fails on the
next request.

## `DELETE /admin/api/users/{id}`

Sets `revoked_at`; response `{ "success": true }`. The row remains for audit.

## Errors

- 401 missing/invalid key.
- 403 valid key without admin role.
- 404 unknown user.
- 400 invalid limits/role/label.
- 429 quota exceeded on `/v1/*`, with `Retry-After`.
