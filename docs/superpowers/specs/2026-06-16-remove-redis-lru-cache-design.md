# Remove Redis, Replace with lru-cache (HTTP) and No-op Cache (stdio)

**Date:** 2026-06-16  
**Status:** Approved

## Problem

Redis is a hard `dependency` in `package.json` and is imported at the top level of `main.ts`. It was added to provide a shared schema cache for the HTTP transport across multiple requests. However:

- stdio mode never connects to Redis — it already uses an in-memory Map cache — but the package is always installed and the module always loaded.
- For a single-process deployment (the common case), Redis adds no value over a well-sized in-memory cache.
- stdio should be fully stateless — no caching of any kind.

## Goals

- Remove the `redis` npm package entirely.
- HTTP transport: use `lru-cache` (npm) for in-memory schema caching with TTL and max-size eviction.
- stdio transport: no caching — every tool call fetches fresh from ServiceNow.
- Retain the existing `SchemaCache<T>` interface so tools are untouched.

## Approach

Keep the `SchemaCache<T>` interface (`get`, `set`, `clear`). Swap the implementation behind it:

- **HTTP** → `createSchemaCache<T>` backed by `LRUCache` from `lru-cache`
- **stdio** → `createNoopSchemaCache<T>` that returns `undefined` on `get` and ignores `set`/`clear`

This keeps the change surface minimal — only the cache layer, config, `main.ts`, `server.ts`, compose files, and tests change. All tools are untouched.

## File-by-file Changes

### `package.json`

- Remove `redis` from `dependencies`
- Add `lru-cache` to `dependencies`

### `src/servicenow/schema-cache.ts`

- Replace the Map-based LRU implementation with an `LRUCache` wrapper from `lru-cache`
- Add `createNoopSchemaCache<T>()` — `get` always returns `undefined`, `set`/`clear` are no-ops
- `SchemaCacheOptions` shape (`ttlMs`, `maxEntries`) unchanged; maps to lru-cache's `ttl` and `max`
- `SchemaCache<T>` interface unchanged

### `src/servicenow/schema-cache-redis.ts` + test

- Delete both files entirely

### `src/config.ts`

- Remove `RedisConfig` interface
- Remove `redis?: RedisConfig` from `ServerConfig`
- Remove `REDIS_URL` validation block
- `SCHEMA_CACHE_TTL_MS` and `SCHEMA_CACHE_MAX_ENTRIES` remain (still configure the HTTP lru-cache)

### `src/mcp/server.ts`

- Remove `import type { RedisClientType } from 'redis'`
- Remove `RedisOps` type alias
- Remove `createRedisServerCaches`
- Add `createNoopServerCaches()` returning `ServerCaches` with no-op caches
- `createServerCaches(cacheConfig)` stays, now wraps lru-cache

### `src/main.ts`

- Remove `import { createClient } from 'redis'`
- Remove `createRedisServerCaches` from import
- HTTP branch: call `createServerCaches(config.cache)` (lru-cache backed), no Redis connect/disconnect
- stdio branch: call `createNoopServerCaches()`
- `buildServer()` (test helper): call `createNoopServerCaches()`

### `docker-compose.yml` + `docker-compose.ghcr.yml`

- Remove `redis:` service block
- Remove `depends_on: redis` from `snow-mcp` service
- Remove `REDIS_URL` from `environment:` block

### `.env.example`

- Remove `REDIS_URL`

### `src/servicenow/schema-cache.test.ts`

- Update to exercise the lru-cache wrapper; TTL and eviction tests remain structurally the same

### `src/servicenow/schema-cache-redis.test.ts`

- Delete (file gone)

### `src/mcp/server.test.ts` + `src/main.test.ts`

- Replace any references to `createRedisServerCaches` / `RedisConfig` with `createNoopServerCaches` / `createServerCaches`
- No Redis mocks — ServiceNow HTTP layer remains the only mock boundary

## Trade-offs

|                             | Before          | After                      |
| --------------------------- | --------------- | -------------------------- |
| stdio caching               | In-memory Map   | None (stateless)           |
| HTTP caching                | Redis           | In-memory LRU (lru-cache)  |
| Multi-replica cache sharing | Yes (via Redis) | No                         |
| External service required   | Yes (Redis)     | No                         |
| Install footprint           | redis + deps    | lru-cache (no native deps) |

Multi-replica cache sharing is dropped. For the typical single-process MCP deployment this has no impact — each process already had its own Redis connection and the cache was warm within seconds anyway.

## Out of Scope

- Changing tool behavior or ServiceNow API calls
- Adding distributed caching for multi-replica HTTP (future concern if needed)
- Any write operations to ServiceNow
