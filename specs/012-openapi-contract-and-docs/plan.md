# Implementation Plan: OpenAPI Contract and API Documentation

**Branch**: `012-openapi-contract-and-docs` | **Date**: 2026-11-09 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/012-openapi-contract-and-docs/spec.md`

## Summary

Publish the existing hand-maintained `docs/openapi.yaml` as the canonical
OpenAPI 3.1 contract, serve it at `GET /openapi.json`, and render a
self-contained interactive viewer at `GET /docs`. Both routes are public and
dependency-free in the browser: the page loads no CDN assets, keeps the
operator-entered API key in a JavaScript variable only, and never writes it to
storage or the URL. A contract test derives every public Hono route, asserts
that each one is documented, validates all embedded examples against their
schemas, checks the served document and docs page, and scans for secret-shaped
strings. The test runs in the standard mock suites so endpoint drift fails CI.

## Technical Context

**Language/Version**: TypeScript on Node.js 22+

**Primary Dependencies**: `hono` (already present) plus `yaml@^2.9.1` to parse
the YAML contract at runtime and in tests

**Storage**: none; the parsed document is cached in memory by file path and
modification time so edits are picked up without a restart

**Testing**: `node:test` via tsx. `src/tests/openapi-contract.test.ts` covers
document validity, public-route coverage (including the Gemini wildcard),
example/schema validation with a local JSON-Schema subset validator, the served
`/openapi.json` and `/docs` responses, the absence of external script/style
URLs, and the presence of OpenAI, Anthropic and Gemini error envelopes.

**Target Platform**: Windows and Linux, Docker-compatible

**Project Type**: Single TypeScript service with TUI and HTTP API

**Performance Goals**: Parse the contract once and reuse it while the file's
mtime is unchanged; `/openapi.json` is a JSON serialization of the cached
object. `/docs` is a constant HTML string.

**Constraints**: The contract contains no secrets, account emails or production
hostnames. Admin routes are outside the public contract. Streaming endpoints are
documented as event streams rather than a single JSON schema. The viewer must
work offline and must not persist the API key. `docs/openapi.yaml` ships in the
npm package (`files`).

**Scale/Scope**: 26 documented paths covering chat, legacy completions,
Anthropic, Responses, Gemini, models, uploads, images, videos, operations and
the docs endpoints themselves.

## Constitution Check

- **Upstream compatibility**: no existing route or payload changes; the feature
  only documents and serves the current surface. PASS.
- **Browser-transport fidelity**: no new upstream transport path. PASS.
- **Account isolation**: the contract exposes the API shape, never account
  identifiers or credentials. PASS.
- **Spec-driven**: spec, plan, tasks and contract tests accompany the change.
  PASS.
- **Observability**: `docs.ts` logs contract loading failures; the contract test
  fails on drift. PASS.
- **Tests**: focused contract tests plus typecheck and the full mock suite.
  PASS.
- **Security**: `/docs` and `/openapi.json` contain no secrets; the viewer keeps
  the key in memory only and uses no external resources. PASS.
- **Simplicity**: one small module (`src/api/docs.ts`) and one test file; no
  runtime framework for the viewer. PASS.

## Project Structure

```text
src/
├── api/
│   ├── docs.ts                     # contract loading/cache + /openapi.json + /docs
│   └── server.ts                   # mounts docsApp, adds public probe paths
├── tests/
│   └── openapi-contract.test.ts    # validity, route coverage, examples, serving
docs/
└── openapi.yaml                    # canonical OpenAPI 3.1 contract
specs/012-openapi-contract-and-docs/
├── plan.md
├── tasks.md
└── spec.md
```

## Integration Points

1. `docsApp` is mounted on the main Hono app after the protocol routers.
2. `/openapi.json` and `/docs` are added to the public probe list so the auth
   middleware does not require a key and error metrics do not count them as API
   traffic.
3. `resolveOpenApiPath` checks the working directory, the source tree and the
   bundled `dist/../docs` layout; `package.json` ships `docs/openapi.yaml`.
4. The contract test reads `app.routes`, filters admin and wildcard internals,
   converts Hono `:param` segments to OpenAPI `{param}` and checks each method
   and path.
5. The docs viewer fetches `/openapi.json`, groups operations by tag, renders a
   filterable sidebar and per-operation "Try it" forms, and streams SSE
   responses incrementally.

## Phases

- Phase 1 — extend the contract: all public paths, shared parameters, protocol
  schemas, error envelopes and tags.
- Phase 2 — serve the contract and viewer: `src/api/docs.ts`, server mounting,
  public probes, YAML dependency and package `files`.
- Phase 3 — contract tests: validity, route coverage, examples, docs serving and
  secret scanning; wire them into `test:mock` and `test:mock:fast`.
- Phase 4 — documentation, typecheck, full mock suite, live checks, commit and
  push.

## Complexity Tracking

No constitution violations. The feature adds one API module, one test file and
one small runtime dependency dedicated to parsing the canonical YAML.
