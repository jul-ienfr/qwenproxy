# Phase 0 Research: Multi-User API Keys and Quotas

## Decision: hash API keys with SHA-256

Generated keys have at least 192 bits of entropy. SHA-256 with a unique index is
sufficient and avoids a password-hashing cost on every request. Store the hex
digest and a short display prefix; never store the plaintext key.

**Alternatives considered**:
- bcrypt/argon2: intentionally slow; unnecessary for high-entropy keys and adds
  latency to every request.
- HMAC with a server pepper: better if the database leaks, but introduces key
  rotation and startup coupling. Can be added later without changing the API.

## Decision: in-memory sliding-window RPM

Keep a per-user array of request timestamps for the last 60 seconds, prune on
each check, and reject when the count reaches the limit. This is O(limit) with
small limits and avoids a write per request.

**Alternatives considered**:
- SQLite counter per minute: durable but adds a write to every request.
- Token bucket: smoother but harder to explain to operators; RPM is the
  published contract.

## Decision: in-memory concurrency counters

Increment on stream acquire and decrement exactly once on completion, error or
cancel. A `ReadableStream` wrapper owns the release so a client disconnect does
not leak a slot.

**Alternatives considered**:
- Count active HTTP requests: streams return a Response immediately, so the
  counter would drop while the stream is still running.
- Reuse account lease counts: those are per Qwen account, not per consumer.

## Decision: legacy key stays a global admin

`API_KEY` is a low-entropy operator secret; hashing it into the users table would
not add security and would complicate rotation. Keep the existing constant-time
comparison and grant the `admin` role, bypassing quotas.

## Decision: admin API under `/admin/api/users`

The future web dashboard (spec 003) needs a stable contract. The API is
authenticated by the same Bearer/x-api-key header and requires role `admin`.
The CLI writes SQLite directly for bootstrap/offline use; the API is the live
management surface.

## Open questions resolved

- Should a user with `rpm=0` be unlimited or blocked? Unlimited, matching the
  existing account convention.
- Should revoked keys be deleted or marked? Marked with `revoked_at` for audit.
- Should token usage be persisted per user now? Only request/stream counters in
  this slice; token attribution is added with the dashboard/usage work.
