# Resource Caching via node:sqlite, Tiered TTLs, Both Transports

**Date:** 2026-07-09
**Status:** Approved

## Problem

Today's cache (`src/servicenow/schema-cache.ts`, an `lru-cache` wrapper) only
covers `describe_table` and `list_tables`, is in-memory only, and is wired up
for HTTP transport only — stdio deliberately runs with
`createNoopServerCaches()` because each stdio session is a short-lived
process (see 2026-06-16-remove-redis-lru-cache-design.md).

This leaves most tools (`query_table`, `get_record`, `aggregate`,
`run_saved_report`, `get_user_context`) and the `servicenow://tables`
resource always hitting ServiceNow live, and every stdio session starts
cold with zero reuse even across repeated tool calls within one session.

## Goals

- Widen caching to all tools/resources except `get_attachment` (binary,
  potentially large, typically immutable — not worth the disk cost).
- Cache with per-type TTL tiers, not one blanket TTL.
- Back the cache with `node:sqlite` (built into Node 24, no new npm
  dependency) instead of `lru-cache`, so it can survive process restarts.
- Enable caching for **both** stdio and HTTP transports.
- Give callers a way to force real-time data despite caching.
- Keep the MCP server itself stateless: the cache is a disposable local
  optimization, never a source of truth, safe to delete at any time, and
  requires no cross-instance coordination (each process/container owns its
  own sqlite file).
- No `setInterval`/timers for cache maintenance — a lingering timer handle
  risks reintroducing the stdin-close hang bug fixed on 2026-07-09
  (aborted-fetch sockets keeping the event loop alive). Expiry cleanup is
  inline (lazy-on-read, opportunistic-on-write), not backgrounded.

## Non-goals

- Multi-replica/shared cache coordination (each HTTP replica or stdio
  container has its own local file — same limitation the prior lru-cache
  design already accepted).
- Caching `get_attachment` binary content.
- Any ServiceNow write/mutation — `clear_cache` (below) is a purely local
  operation and does not touch the ServiceNow API.
- Backward-compatible aliasing of the old `SCHEMA_CACHE_TTL_MS` /
  `SCHEMA_CACHE_MAX_ENTRIES` env vars — this is a breaking config rename.

## Approach

Replace the `SchemaCache<T>` abstraction with a generalized
`ResourceCache`, backed by `node:sqlite`'s `DatabaseSync`, keyed by
`(kind, params)`, with kind-to-TTL-tier mapping and a `clear_cache` MCP
tool for on-demand invalidation.

### Storage schema

```sql
CREATE TABLE IF NOT EXISTS cache_entries (
  key        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  value      TEXT NOT NULL,       -- JSON-serialized
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_kind ON cache_entries(kind);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries(expires_at);
```

DDL runs idempotently (`CREATE TABLE IF NOT EXISTS`) at startup against
`CACHE_DB_PATH` — the file and schema are auto-created at runtime, not
baked into the image as data. The image build only guarantees a writable
directory exists at that path (see Docker section).

### Module interface (`src/cache/resource-cache.ts`)

Keeps the same async shape as the old `SchemaCache<T>` to minimize
call-site churn, even though `DatabaseSync` is synchronous internally:

```ts
export type CacheKind = 'schema' | 'catalog' | 'user_context' | 'record' | 'aggregate' | 'report';

export interface ResourceCache {
  get<T>(kind: CacheKind, key: string): Promise<T | undefined>;
  set<T>(kind: CacheKind, key: string, value: T): Promise<void>;
  clear(kind?: CacheKind): Promise<number>; // rows removed
}

export function createNoopResourceCache(): ResourceCache; // all TTL tiers <= 0
export function createResourceCache(opts: ResourceCacheOptions): ResourceCache;
```

- **Key**: `` `${kind}:${stableStringify(params)}` ``. A small
  `stableStringify` helper sorts object keys so identical params produce
  identical keys regardless of construction order.
- **Read**: `get()` checks `expires_at < now`; an expired row is treated as
  a miss and deleted inline (no separate sweep needed for reads).
- **Write**: `set()` first runs
  `DELETE FROM cache_entries WHERE expires_at < :now` (cheap, indexed),
  then upserts the new row. This is the only expiry sweep — no timer.
- **Size safety valve**: `CACHE_MAX_ENTRIES` (global, across all kinds,
  default 1000). After the expiry sweep in `set()`, if row count still
  exceeds the cap, delete oldest rows by `created_at` until back under it.
- Each tool call still owns building its own cache key from its own
  params — the module itself has no ServiceNow-specific knowledge.

### TTL tiers & config

Three shared tiers (env vars), each disables its tier when `<= 0`
(matches the existing `ttlMs <= 0` → noop convention):

| Tier   | Env var               | Default        | Kinds                           |
| ------ | --------------------- | -------------- | ------------------------------- |
| long   | `CACHE_TTL_LONG_MS`   | `3600000` (1h) | `schema`, `catalog`             |
| medium | `CACHE_TTL_MEDIUM_MS` | `900000` (15m) | `user_context`                  |
| short  | `CACHE_TTL_SHORT_MS`  | `45000` (45s)  | `record`, `aggregate`, `report` |

Other new/changed config:

- `CACHE_DB_PATH` — default `/app/data/cache.sqlite` in the container;
  `.cache/snow-mcp.sqlite` (relative to cwd) for local `yarn dev`.
- `CACHE_MAX_ENTRIES` — default `1000`, global row cap.
- `SCHEMA_CACHE_TTL_MS` / `SCHEMA_CACHE_MAX_ENTRIES` are **removed**
  (breaking rename, not aliased) — replaced by the tiered vars above.

### Kind-to-tool mapping

| Tool / resource                | Kind           | Tier   |
| ------------------------------ | -------------- | ------ |
| `describe_table`               | `schema`       | long   |
| `list_tables`                  | `catalog`      | long   |
| `servicenow://tables` resource | `catalog`      | long   |
| `get_user_context`             | `user_context` | medium |
| `get_record`                   | `record`       | short  |
| `query_table`                  | `record`       | short  |
| `aggregate`                    | `aggregate`    | short  |
| `run_saved_report`             | `report`       | short  |
| `get_attachment`               | — (uncached)   | —      |

### Cache invalidation: `clear_cache` tool

Real-time freshness is opt-in per caller, not automatic. New MCP tool,
purely local (no ServiceNow calls, so it's compliant with the read-only
constraint):

```ts
// input:  { kind?: 'schema' | 'catalog' | 'user_context' | 'record' | 'aggregate' | 'report' }
// output: { clearedCount: number }
```

No `kind` clears every entry. Callers invoke it before a read that must be
current (e.g. right after a known change was made in ServiceNow by another
process) or to scope-clear one kind (e.g. just `record`) without discarding
unrelated schema/catalog cache. Registered in `server.ts` like any other
tool; inherits the same transport auth as the rest of the tools.

### Docker: writable path in a distroless nonroot image

The runtime stage (`gcr.io/distroless/nodejs24-debian12:nonroot`) has no
shell, so there's no `RUN mkdir && chown` available there, and
`COPY --from=builder` without `--chown` copies as root — which the
nonroot runtime user can't write to. Fix: add a second `WORKDIR` for the
data directory. Docker's `WORKDIR` creates missing directories owned by
the stage's currently active user, and the distroless `:nonroot` base
already sets that user by default — no shell required:

```dockerfile
WORKDIR /app
...
WORKDIR /app/data
ENV CACHE_DB_PATH=/app/data/cache.sqlite
```

The app's `CREATE TABLE IF NOT EXISTS` DDL runs against this path on
first startup — the directory and its permissions are what's "baked into
the image"; the sqlite file and schema are created at runtime.

### `.gitignore`

Add cache file patterns so local dev runs (`yarn dev`) don't leave a
tracked sqlite file:

```
*.sqlite
*.sqlite3
.cache/
```

## File-by-file Changes

### `package.json`

- Remove `lru-cache` from `dependencies` (no longer needed; `node:sqlite`
  is a Node 24 built-in).

### `src/servicenow/schema-cache.ts` + `schema-cache.test.ts`

- Delete both files entirely.

### `src/cache/resource-cache.ts` (new) + `resource-cache.test.ts` (new)

- `DatabaseSync`-backed implementation per the interface above.
- `createNoopResourceCache()` for the all-tiers-disabled case.
- Tests use a real `node:sqlite` `DatabaseSync(':memory:')` — sqlite is
  local/deterministic, not a system boundary, so per the testing rules it
  is exercised for real rather than mocked. The ServiceNow HTTP layer
  remains the only mocked boundary.

### `src/cache/stable-stringify.ts` (new) + test

- Deterministic JSON serialization (sorted object keys) for cache key
  construction.

### `src/config.ts`

- Replace `CacheConfig { ttlMs, maxEntries }` with
  `CacheConfig { ttlLongMs, ttlMediumMs, ttlShortMs, maxEntries, dbPath }`.
- Parse `CACHE_TTL_LONG_MS`, `CACHE_TTL_MEDIUM_MS`, `CACHE_TTL_SHORT_MS`,
  `CACHE_MAX_ENTRIES`, `CACHE_DB_PATH` (remove `SCHEMA_CACHE_TTL_MS` /
  `SCHEMA_CACHE_MAX_ENTRIES` parsing).

### `src/mcp/server.ts`

- Remove `createNoopServerCaches()` special-casing for stdio — both
  transports call the same `createServerCaches(config.cache)`.
- `ServerCaches` now holds one shared `ResourceCache` (not two separate
  `SchemaCache` instances) plus per-tool kind constants.

### `src/mcp/tools/*.ts`

- `describe-table.ts`, `list-tables.ts` — swap `SchemaCache` calls for
  `ResourceCache` with kind `'schema'` / `'catalog'`.
- `get-record.ts`, `query-table.ts`, `aggregate.ts`, `run-saved-report.ts`,
  `get-user-context.ts` — add cache read-through/write-through with their
  respective kinds.
- `get-attachment.ts` — untouched, stays uncached.
- `clear-cache.ts` (new) — implements the `clear_cache` tool.

### `src/mcp/resources/tables.ts`

- Accept the shared `ResourceCache`, cache under kind `'catalog'` with the
  same key convention as `list_tables`.

### `src/main.ts`

- Both the stdio and HTTP branches call `createServerCaches(config.cache)`.
- `buildServer()` test helper does the same (no more forced noop for
  stdio).

### `Dockerfile`

- Add the `WORKDIR /app/data` + `ENV CACHE_DB_PATH=/app/data/cache.sqlite`
  lines described above.

### `.gitignore`

- Add `*.sqlite`, `*.sqlite3`, `.cache/`.

### `.env.example`

- Remove `SCHEMA_CACHE_TTL_MS`, `SCHEMA_CACHE_MAX_ENTRIES`.
- Add `CACHE_TTL_LONG_MS`, `CACHE_TTL_MEDIUM_MS`, `CACHE_TTL_SHORT_MS`,
  `CACHE_MAX_ENTRIES`, `CACHE_DB_PATH`.

### `README.md`

- Update the Configuration table and the "stdio is stateless" language
  (no longer true — both transports cache now).
- Document `clear_cache`.

### `docker-compose.yml` / `docker-compose.ghcr.yml`

- Add the new `CACHE_*` env vars to the `environment:` block (replacing
  `SCHEMA_CACHE_*`).

## Trade-offs

|                             | Before                               | After                                                                                             |
| --------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| stdio caching               | None (stateless)                     | Cached, sqlite-backed, in-container only                                                          |
| HTTP caching                | In-memory LRU (lru-cache)            | sqlite-backed, survives process restarts                                                          |
| Cached surface              | describe_table, list_tables          | + query_table, get_record, aggregate, run_saved_report, get_user_context, tables resource         |
| TTL granularity             | One value for both cached tools      | 3 tiers (long/medium/short) mapped by kind                                                        |
| Manual invalidation         | None                                 | `clear_cache` tool, global or per-kind                                                            |
| Multi-replica cache sharing | No                                   | No (unchanged — still local per process)                                                          |
| New dependency              | `lru-cache`                          | None (`node:sqlite` is built in); `lru-cache` removed                                             |
| Data at rest                | In-memory only, gone on process exit | Written to disk inside the container; gitignored, not committed, ephemeral per container lifetime |

## Out of Scope

- Caching `get_attachment` binary content.
- Distributed/shared caching across HTTP replicas.
- Baking real cached data into the Docker image (only the writable
  directory permissions are build-time; actual cache entries are always
  runtime-created).
- Any write/mutation to the ServiceNow API.
