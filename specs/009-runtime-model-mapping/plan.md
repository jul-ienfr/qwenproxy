# Implementation Plan: Runtime Model Mapping and Aliases

**Feature Branch**: `009-runtime-model-mapping`

**Status**: Implemented

## Summary

Add an operator-controlled runtime layer in front of the existing
`model-alias.ts` resolver. Mappings are stored in
`data/model-mappings.json`, seeded from the `MODEL_MAP` environment variable
when no file exists, and can be edited from the admin API/dashboard without a
restart. The runtime layer wraps, but does not replace, the built-in
OpenAI/Anthropic/Gemini family aliases.

Resolution order (per request, after public suffixes are stripped):

1. Exact runtime alias (case-insensitive).
2. Built-in family alias (`mapKnownModelAlias`, Anthropic family logic).
3. Wildcard runtime fallback (`*=qwen-id`), only for non-Qwen-native ids.
4. Pass through unchanged.

Qwen-native ids (`qwen*`, media ids such as `wan*` / `z-image*`) are never
rewritten by the wildcard fallback.

## Storage

`src/core/model-mapping.ts` owns the mapping lifecycle:

- `parseModelMap(input)` parses `alias=qwen-id,...,*=fallback`.
- `validateModelMappings(...)` rejects empty values, duplicate aliases,
  Qwen-prefixed aliases, reserved reasoning/search suffixes, whitespace in
  aliases, alias chains/cycles, and a fallback that targets an alias.
- `getModelMappingState()` returns the sanitized state plus its source
  (`file`, `env`, `default`) for the admin API.
- `saveModelMappings(...)` validates, writes atomically (temp file + rename),
  and refreshes the cache.
- `resetModelMappings()` deletes the file and falls back to `MODEL_MAP`.
- `findExactModelMapping` / `getModelMappingFallback` are the hot-path
  lookups, backed by an mtime-based cache so dashboard edits apply on the
  next request.

`src/core/paths.ts` gains `getModelMappingsPath()`.

## Integration points

- `mapClientModelToQwen`: exact runtime → built-in → wildcard → passthrough.
- `mapAnthropicModel`: exact runtime → Anthropic family → wildcard.
- `mapGeminiModel`: reuse `mapClientModelToQwen` so all protocols share the
  same precedence.
- `/v1/models` and `/v1/models/:model`: append alias entries whose
  `context_window`/`capabilities` are read from the target model; expose
  `mapped_to` for clients and use it in the Anthropic catalog shape.
- Legacy `/v1/completions`: already dispatches through `/v1/chat/completions`,
  so it inherits the mapping automatically.
- Admin API: `GET`/`PUT`/`DELETE /admin/api/model-mappings` with audit
  records; Settings tab gains a textarea editor.

## Validation and errors

- Invalid admin payloads return HTTP 400 with the specific validation errors.
- An unknown target is not rejected at save time (operators may map to a
  model that appears later), but the next request fails upstream with a
  clear model-not-found error from Qwen.
- A corrupt persistence file is ignored (empty mapping) and logged; the
  previous behavior is preserved.

## Verification

- Unit tests for parsing, validation, precedence, hot reload, and native-id
  passthrough.
- Admin API tests for GET/PUT/DELETE, invalid payloads, and audit records.
- `/v1/models` test proving aliases are advertised with target metadata.
- Protocol tests for OpenAI, Anthropic, and Gemini translation helpers.
- `npm run typecheck`, focused tests, then the full `npm run test:mock`
  suite; commit and push.
