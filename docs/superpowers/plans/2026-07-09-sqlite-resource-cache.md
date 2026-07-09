# Sqlite Resource Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `lru-cache`-backed, HTTP-only, schema-only cache with a `node:sqlite`-backed cache used by every read tool (except `get_attachment`) on both stdio and HTTP transports, with three TTL tiers and a `clear_cache` tool for on-demand invalidation.

**Architecture:** A single new module, `src/cache/resource-cache.ts`, wraps `node:sqlite`'s `DatabaseSync` behind the same async `get`/`set`/`clear` shape the old `SchemaCache<T>` had, but keyed by `(kind, key)` instead of just `key`. Six `CacheKind` values map to three TTL tiers (`long`/`medium`/`short`) baked into the module. Expiry cleanup happens inline on every `set()` — no timers, matching the constraint that a lingering timer handle could reintroduce the stdin-close hang bug. `src/cache/stable-stringify.ts` gives every cacheable tool a deterministic cache key from its input object. Every tool file that gets caching takes the shared `ResourceCache` as a constructor argument, same pattern the two originally-cached tools already used for `SchemaCache`.

**Tech Stack:** TypeScript ESM, Node 24 (`node:sqlite`, built-in, no new dependency), Vitest, Zod

**Reference spec:** `docs/superpowers/specs/2026-07-09-sqlite-resource-cache-design.md`

---

### Task 1: Add `stableStringify` helper

**Files:**

- Create: `src/cache/stable-stringify.ts`
- Test: `src/cache/stable-stringify.test.ts`

- [ ] **Step 1: Write the failing tests**

Write `src/cache/stable-stringify.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { stableStringify } from './stable-stringify.js';

describe('stableStringify', () => {
  it('produces identical output regardless of object key order', () => {
    const a = stableStringify({ table: 'incident', sys_id: 'abc' });
    const b = stableStringify({ sys_id: 'abc', table: 'incident' });
    expect(a).toBe(b);
  });

  it('normalises key order in nested objects', () => {
    const a = stableStringify({ outer: { z: 1, a: 2 } });
    const b = stableStringify({ outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it('preserves array element order', () => {
    const out = stableStringify({ fields: ['b', 'a'] });
    expect(out).toBe('{"fields":["b","a"]}');
  });

  it('omits keys whose value is undefined, matching JSON.stringify', () => {
    const out = stableStringify({ table: 'incident', filter: undefined });
    expect(out).toBe('{"table":"incident"}');
  });

  it('serialises primitives directly', () => {
    expect(stableStringify('incident')).toBe('"incident"');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/cache/stable-stringify.test.ts`
Expected: FAIL — `Cannot find module './stable-stringify.js'`

- [ ] **Step 3: Implement stableStringify**

Write `src/cache/stable-stringify.ts`:

```ts
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/cache/stable-stringify.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cache/stable-stringify.ts src/cache/stable-stringify.test.ts
git commit -m "feat(cache): add stableStringify for deterministic cache keys"
```

---

### Task 2: Add the `node:sqlite`-backed `ResourceCache`

**Files:**

- Create: `src/cache/resource-cache.ts`
- Test: `src/cache/resource-cache.test.ts`

This is the core module: a single sqlite table (`cache_entries`) storing JSON-serialized values keyed by `kind:key`, with six `CacheKind` values mapped to three TTL tiers, lazy-on-read expiry, an opportunistic sweep-on-write (no timers), and a global row cap.

- [ ] **Step 1: Write the failing tests**

Write `src/cache/resource-cache.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResourceCache, createNoopResourceCache } from './resource-cache.js';

const BASE_OPTS = {
  dbPath: ':memory:',
  ttlLongMs: 1000,
  ttlMediumMs: 1000,
  ttlShortMs: 1000,
  maxEntries: 10,
};

describe('createResourceCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns set value on get within ttl', async () => {
    const cache = createResourceCache(BASE_OPTS);
    await cache.set('schema', 'incident', { label: 'Incident' });
    expect(await cache.get('schema', 'incident')).toEqual({ label: 'Incident' });
  });

  it('returns undefined when entry has expired', async () => {
    const cache = createResourceCache(BASE_OPTS);
    await cache.set('record', 'a', 1);
    vi.advanceTimersByTime(1001);
    expect(await cache.get('record', 'a')).toBeUndefined();
  });

  it('is still valid at the exact ttl boundary', async () => {
    const cache = createResourceCache(BASE_OPTS);
    await cache.set('record', 'a', 1);
    vi.advanceTimersByTime(1000);
    expect(await cache.get('record', 'a')).toBe(1);
  });

  it('disabling the short tier does not affect the long tier', async () => {
    const cache = createResourceCache({ ...BASE_OPTS, ttlShortMs: 0 });
    await cache.set('schema', 'a', 'kept');
    expect(await cache.get('schema', 'a')).toBe('kept');
  });

  it('disabling the short tier makes the record kind a no-op', async () => {
    const cache = createResourceCache({ ...BASE_OPTS, ttlShortMs: 0 });
    await cache.set('record', 'a', 'dropped');
    expect(await cache.get('record', 'a')).toBeUndefined();
  });

  it('different kinds do not collide on the same raw key', async () => {
    const cache = createResourceCache(BASE_OPTS);
    await cache.set('schema', 'x', 'schema-value');
    await cache.set('record', 'x', 'record-value');
    expect(await cache.get('schema', 'x')).toBe('schema-value');
  });

  it('clear(kind) removes only that kind', async () => {
    const cache = createResourceCache(BASE_OPTS);
    await cache.set('schema', 'a', 1);
    await cache.set('record', 'b', 2);
    await cache.clear('schema');
    expect(await cache.get('record', 'b')).toBe(2);
  });

  it('clear(kind) empties the cleared kind', async () => {
    const cache = createResourceCache(BASE_OPTS);
    await cache.set('schema', 'a', 1);
    await cache.clear('schema');
    expect(await cache.get('schema', 'a')).toBeUndefined();
  });

  it('clear() with no kind removes every entry', async () => {
    const cache = createResourceCache(BASE_OPTS);
    await cache.set('schema', 'a', 1);
    await cache.set('record', 'b', 2);
    await cache.clear();
    expect(await cache.get('record', 'b')).toBeUndefined();
  });

  it('clear() returns the number of rows removed', async () => {
    const cache = createResourceCache(BASE_OPTS);
    await cache.set('schema', 'a', 1);
    await cache.set('record', 'b', 2);
    expect(await cache.clear()).toBe(2);
  });

  it('evicts the oldest entry when maxEntries is exceeded', async () => {
    const cache = createResourceCache({ ...BASE_OPTS, maxEntries: 2 });
    await cache.set('schema', 'a', 1);
    vi.advanceTimersByTime(1);
    await cache.set('schema', 'b', 2);
    vi.advanceTimersByTime(1);
    await cache.set('schema', 'c', 3);
    expect(await cache.get('schema', 'a')).toBeUndefined();
  });

  it('keeps the newest entries after eviction', async () => {
    const cache = createResourceCache({ ...BASE_OPTS, maxEntries: 2 });
    await cache.set('schema', 'a', 1);
    vi.advanceTimersByTime(1);
    await cache.set('schema', 'b', 2);
    vi.advanceTimersByTime(1);
    await cache.set('schema', 'c', 3);
    expect(await cache.get('schema', 'c')).toBe(3);
  });

  it('returns a no-op cache when every tier ttl is 0', async () => {
    const cache = createResourceCache({
      ...BASE_OPTS,
      ttlLongMs: 0,
      ttlMediumMs: 0,
      ttlShortMs: 0,
    });
    await cache.set('schema', 'a', 1);
    expect(await cache.get('schema', 'a')).toBeUndefined();
  });

  it('creates the parent directory when the db file path does not exist yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resource-cache-'));
    const dbPath = join(dir, 'nested', 'cache.sqlite');
    createResourceCache({ ...BASE_OPTS, dbPath });
    expect(existsSync(dbPath)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('createNoopResourceCache', () => {
  it('get always returns undefined even after set', async () => {
    const cache = createNoopResourceCache();
    await cache.set('schema', 'a', 1);
    expect(await cache.get('schema', 'a')).toBeUndefined();
  });

  it('clear resolves to 0', async () => {
    const cache = createNoopResourceCache();
    await expect(cache.clear()).resolves.toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/cache/resource-cache.test.ts`
Expected: FAIL — `Cannot find module './resource-cache.js'`

- [ ] **Step 3: Implement the resource cache**

Write `src/cache/resource-cache.ts`:

```ts
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const CACHE_KINDS = [
  'schema',
  'catalog',
  'user_context',
  'record',
  'aggregate',
  'report',
] as const;

export type CacheKind = (typeof CACHE_KINDS)[number];

type CacheTier = 'long' | 'medium' | 'short';

const KIND_TIER: Record<CacheKind, CacheTier> = {
  schema: 'long',
  catalog: 'long',
  user_context: 'medium',
  record: 'short',
  aggregate: 'short',
  report: 'short',
};

export interface ResourceCacheOptions {
  dbPath: string;
  ttlLongMs: number;
  ttlMediumMs: number;
  ttlShortMs: number;
  maxEntries: number;
}

export interface ResourceCache {
  get<T>(kind: CacheKind, key: string): Promise<T | undefined>;
  set<T>(kind: CacheKind, key: string, value: T): Promise<void>;
  clear(kind?: CacheKind): Promise<number>;
}

export function createNoopResourceCache(): ResourceCache {
  return {
    async get() {
      return undefined;
    },
    async set() {},
    async clear() {
      return 0;
    },
  };
}

export function createResourceCache(opts: ResourceCacheOptions): ResourceCache {
  const tierTtl: Record<CacheTier, number> = {
    long: opts.ttlLongMs,
    medium: opts.ttlMediumMs,
    short: opts.ttlShortMs,
  };
  if (tierTtl.long <= 0 && tierTtl.medium <= 0 && tierTtl.short <= 0) {
    return createNoopResourceCache();
  }

  if (opts.dbPath !== ':memory:') {
    mkdirSync(dirname(opts.dbPath), { recursive: true });
  }

  const db = new DatabaseSync(opts.dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      key        TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      value      TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cache_kind ON cache_entries(kind);
    CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries(expires_at);
  `);

  const selectStmt = db.prepare('SELECT value, expires_at FROM cache_entries WHERE key = ?');
  const deleteKeyStmt = db.prepare('DELETE FROM cache_entries WHERE key = ?');
  const deleteExpiredStmt = db.prepare('DELETE FROM cache_entries WHERE expires_at < ?');
  const upsertStmt = db.prepare(
    'INSERT OR REPLACE INTO cache_entries (key, kind, value, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const countStmt = db.prepare('SELECT COUNT(*) as n FROM cache_entries');
  const deleteOldestStmt = db.prepare(
    'DELETE FROM cache_entries WHERE key IN (SELECT key FROM cache_entries ORDER BY created_at ASC LIMIT ?)',
  );
  const deleteAllStmt = db.prepare('DELETE FROM cache_entries WHERE 1 = 1');
  const deleteByKindStmt = db.prepare('DELETE FROM cache_entries WHERE kind = ?');

  function storageKey(kind: CacheKind, key: string): string {
    return `${kind}:${key}`;
  }

  return {
    async get<T>(kind: CacheKind, key: string): Promise<T | undefined> {
      if (tierTtl[KIND_TIER[kind]] <= 0) return undefined;
      const storedKey = storageKey(kind, key);
      const row = selectStmt.get(storedKey) as { value: string; expires_at: number } | undefined;
      if (!row) return undefined;
      if (row.expires_at < Date.now()) {
        deleteKeyStmt.run(storedKey);
        return undefined;
      }
      return JSON.parse(row.value) as T;
    },
    async set<T>(kind: CacheKind, key: string, value: T): Promise<void> {
      const ttl = tierTtl[KIND_TIER[kind]];
      if (ttl <= 0) return;
      const now = Date.now();
      deleteExpiredStmt.run(now);
      upsertStmt.run(storageKey(kind, key), kind, JSON.stringify(value), now + ttl, now);
      const countRow = countStmt.get() as { n: number };
      const overflow = Number(countRow.n) - opts.maxEntries;
      if (overflow > 0) {
        deleteOldestStmt.run(overflow);
      }
    },
    async clear(kind?: CacheKind): Promise<number> {
      const result = kind ? deleteByKindStmt.run(kind) : deleteAllStmt.run();
      return Number(result.changes);
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/cache/resource-cache.test.ts`
Expected: PASS (16 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cache/resource-cache.ts src/cache/resource-cache.test.ts
git commit -m "feat(cache): add node:sqlite-backed ResourceCache with tiered TTLs"
```

---

### Task 3: Update config for tiered cache settings

**Files:**

- Modify: `src/config.ts`
- Modify: `src/config.test.ts`

- [ ] **Step 1: Update the failing/changed tests first**

In `src/config.test.ts`, replace the six tests between `'defaults SCHEMA_CACHE_TTL_MS to 300000'` and `'rejects SCHEMA_CACHE_MAX_ENTRIES below 1'` (current lines 64–95) with:

```ts
it('defaults CACHE_TTL_LONG_MS to 3600000', () => {
  const cfg = loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't' });
  expect(cfg.cache.ttlLongMs).toBe(3_600_000);
});

it('defaults CACHE_TTL_MEDIUM_MS to 900000', () => {
  const cfg = loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't' });
  expect(cfg.cache.ttlMediumMs).toBe(900_000);
});

it('defaults CACHE_TTL_SHORT_MS to 45000', () => {
  const cfg = loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't' });
  expect(cfg.cache.ttlShortMs).toBe(45_000);
});

it('defaults CACHE_MAX_ENTRIES to 1000', () => {
  const cfg = loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't' });
  expect(cfg.cache.maxEntries).toBe(1000);
});

it('defaults CACHE_DB_PATH to .cache/snow-mcp.sqlite', () => {
  const cfg = loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't' });
  expect(cfg.cache.dbPath).toBe('.cache/snow-mcp.sqlite');
});

it('trims and uses a custom CACHE_DB_PATH', () => {
  const cfg = loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't', CACHE_DB_PATH: '  /data/x.sqlite  ' });
  expect(cfg.cache.dbPath).toBe('/data/x.sqlite');
});

it('parses CACHE_TTL_LONG_MS=0 as disabled', () => {
  const cfg = loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't', CACHE_TTL_LONG_MS: '0' });
  expect(cfg.cache.ttlLongMs).toBe(0);
});

it('rejects non-integer CACHE_TTL_LONG_MS', () => {
  expect(() => loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't', CACHE_TTL_LONG_MS: 'abc' })).toThrow(
    /CACHE_TTL_LONG_MS/,
  );
});

it('rejects negative CACHE_TTL_LONG_MS', () => {
  expect(() => loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't', CACHE_TTL_LONG_MS: '-1' })).toThrow(
    /CACHE_TTL_LONG_MS/,
  );
});

it('rejects CACHE_MAX_ENTRIES below 1', () => {
  expect(() => loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't', CACHE_MAX_ENTRIES: '0' })).toThrow(
    /CACHE_MAX_ENTRIES/,
  );
});
```

- [ ] **Step 2: Run the config tests to verify they fail**

Run: `yarn test src/config.test.ts`
Expected: FAIL — `cfg.cache.ttlLongMs` is `undefined`, `CacheConfig` still has the old `ttlMs`/`maxEntries` shape

- [ ] **Step 3: Update config.ts**

In `src/config.ts`, replace the `CacheConfig` interface:

```ts
export interface CacheConfig {
  ttlLongMs: number;
  ttlMediumMs: number;
  ttlShortMs: number;
  maxEntries: number;
  dbPath: string;
}
```

Replace the `const cache: CacheConfig = { ... }` block:

```ts
const cache: CacheConfig = {
  ttlLongMs: parseIntEnv(env, 'CACHE_TTL_LONG_MS', 3_600_000, { min: 0 }),
  ttlMediumMs: parseIntEnv(env, 'CACHE_TTL_MEDIUM_MS', 900_000, { min: 0 }),
  ttlShortMs: parseIntEnv(env, 'CACHE_TTL_SHORT_MS', 45_000, { min: 0 }),
  maxEntries: parseIntEnv(env, 'CACHE_MAX_ENTRIES', 1000, { min: 1 }),
  dbPath: env.CACHE_DB_PATH?.trim() || '.cache/snow-mcp.sqlite',
};
```

- [ ] **Step 4: Run the config tests to verify they pass**

Run: `yarn test src/config.test.ts`
Expected: PASS (all tests, including the new tiered-cache ones)

- [ ] **Step 5: Run typecheck to confirm no stale CacheConfig references remain outside config.ts yet**

Run: `yarn typecheck`
Expected: FAIL — `src/mcp/server.ts` and `src/servicenow/schema-cache.test.ts` still reference the old `CacheConfig`/`ttlMs` shape. This is expected; those are fixed in later tasks. Confirm the only errors are in those two files before moving on.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat(config): replace SCHEMA_CACHE_* with tiered CACHE_TTL_* settings"
```

---

### Task 4: Add the `clear_cache` tool

**Files:**

- Create: `src/mcp/tools/clear-cache.ts`
- Test: `src/mcp/tools/clear-cache.test.ts`

- [ ] **Step 1: Write the failing tests**

Write `src/mcp/tools/clear-cache.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createClearCacheTool } from './clear-cache.js';
import { createResourceCache } from '../../cache/resource-cache.js';

const OPTS = {
  dbPath: ':memory:',
  ttlLongMs: 60_000,
  ttlMediumMs: 60_000,
  ttlShortMs: 60_000,
  maxEntries: 10,
};

describe('clear_cache tool', () => {
  it('clears everything and reports the count when no kind is given', async () => {
    const cache = createResourceCache(OPTS);
    await cache.set('schema', 'a', 1);
    await cache.set('record', 'b', 2);
    const tool = createClearCacheTool(cache);
    const out = await tool.handler({});
    const payload = JSON.parse((out.content?.[0] as { text: string }).text);
    expect(payload.clearedCount).toBe(2);
  });

  it('scopes the clear to the given kind', async () => {
    const cache = createResourceCache(OPTS);
    await cache.set('schema', 'a', 1);
    await cache.set('record', 'b', 2);
    const tool = createClearCacheTool(cache);
    await tool.handler({ kind: 'schema' });
    expect(await cache.get('record', 'b')).toBe(2);
  });

  it('leaves the scoped kind empty after clearing', async () => {
    const cache = createResourceCache(OPTS);
    await cache.set('schema', 'a', 1);
    const tool = createClearCacheTool(cache);
    await tool.handler({ kind: 'schema' });
    expect(await cache.get('schema', 'a')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/mcp/tools/clear-cache.test.ts`
Expected: FAIL — `Cannot find module './clear-cache.js'`

- [ ] **Step 3: Implement the tool**

Write `src/mcp/tools/clear-cache.ts`:

```ts
import { z } from 'zod';
import { CACHE_KINDS, type CacheKind, type ResourceCache } from '../../cache/resource-cache.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const clearCacheInput = {
  kind: z
    .enum(CACHE_KINDS)
    .optional()
    .describe('Limit the clear to one cache kind. Omit to clear everything.'),
};

export interface ClearCacheTool {
  name: 'clear_cache';
  description: string;
  inputShape: typeof clearCacheInput;
  handler(input: { kind?: CacheKind }): Promise<McpResult>;
}

export function createClearCacheTool(cache: ResourceCache): ClearCacheTool {
  return {
    name: 'clear_cache',
    description:
      'Clear cached ServiceNow data so the next read is fetched live. Optionally scope to one cache kind (schema, catalog, user_context, record, aggregate, report).',
    inputShape: clearCacheInput,
    handler: (input) => runTool(async () => ({ clearedCount: await cache.clear(input.kind) })),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/mcp/tools/clear-cache.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/clear-cache.ts src/mcp/tools/clear-cache.test.ts
git commit -m "feat(tools): add clear_cache for on-demand cache invalidation"
```

---

### Task 5: Migrate `describe_table` to `ResourceCache`

**Files:**

- Modify: `src/mcp/tools/describe-table.ts`
- Modify: `src/mcp/tools/describe-table.test.ts`

- [ ] **Step 1: Update the test file to use ResourceCache**

Write `src/mcp/tools/describe-table.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createDescribeTableTool } from './describe-table.js';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { createResourceCache } from '../../cache/resource-cache.js';

const DISABLED = {
  dbPath: ':memory:',
  ttlLongMs: 0,
  ttlMediumMs: 0,
  ttlShortMs: 0,
  maxEntries: 10,
};
const ENABLED = {
  dbPath: ':memory:',
  ttlLongMs: 60_000,
  ttlMediumMs: 60_000,
  ttlShortMs: 60_000,
  maxEntries: 10,
};

function buildClient(): { client: ServiceNowClient; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (table: string) => {
    if (table === 'sys_db_object') {
      return {
        records: [{ name: 'incident', label: 'Incident', super_class: { display_value: 'task' } }],
        total: 1,
      };
    }
    if (table === 'sys_dictionary') {
      return {
        records: [
          {
            element: 'number',
            column_label: 'Number',
            internal_type: { value: 'string' },
            mandatory: 'true',
            read_only: 'true',
          },
          {
            element: 'caller_id',
            column_label: 'Caller',
            internal_type: { value: 'reference' },
            reference: { value: 'sys_user' },
            mandatory: 'false',
            read_only: 'false',
          },
        ],
        total: 2,
      };
    }
    return { records: [], total: 0 };
  });
  const client = {
    table: { query, getRecord: vi.fn() },
    aggregate: { aggregate: vi.fn() },
    attachment: { getAttachment: vi.fn() },
    report: { runSavedReport: vi.fn() },
    userContext: { getUserContext: vi.fn() },
  } as unknown as ServiceNowClient;
  return { client, query };
}

describe('describe_table tool', () => {
  it('returns table metadata plus normalised fields', async () => {
    const { client } = buildClient();
    const cache = createResourceCache(DISABLED);
    const tool = createDescribeTableTool(client, cache);
    const out = await tool.handler({ name: 'incident' });
    const payload = JSON.parse((out.content?.[0] as { text: string }).text);
    expect(payload.name).toBe('incident');
    expect(payload.label).toBe('Incident');
    expect(payload.parent).toBe('task');
    expect(payload.fields).toEqual([
      {
        name: 'number',
        label: 'Number',
        type: 'string',
        reference: undefined,
        mandatory: true,
        readOnly: true,
      },
      {
        name: 'caller_id',
        label: 'Caller',
        type: 'reference',
        reference: 'sys_user',
        mandatory: false,
        readOnly: false,
      },
    ]);
  });

  it('emits a not_found error when the table is unknown', async () => {
    const { client } = buildClient();
    const cache = createResourceCache(DISABLED);
    const tool = createDescribeTableTool(client, cache);
    const out = await tool.handler({ name: 'nope' });
    expect(out.isError).toBe(true);
    expect((out.content?.[0] as { text: string }).text).toContain('not_found');
  });
});

describe('createDescribeTableTool with cache', () => {
  it('returns the cached result on second invocation without calling client.table.query', async () => {
    const { client, query } = buildClient();
    const cache = createResourceCache(ENABLED);
    const tool = createDescribeTableTool(client, cache);

    const first = await tool.handler({ name: 'incident' });
    const second = await tool.handler({ name: 'incident' });

    expect(query).toHaveBeenCalledTimes(2); // first call hits sys_db_object + sys_dictionary
    expect(second).toEqual(first);
  });

  it('hits the client every call when the cache is disabled', async () => {
    const { client, query } = buildClient();
    const cache = createResourceCache(DISABLED);
    const tool = createDescribeTableTool(client, cache);

    await tool.handler({ name: 'incident' });
    await tool.handler({ name: 'incident' });

    expect(query.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/mcp/tools/describe-table.test.ts`
Expected: FAIL — `createResourceCache` result isn't assignable where a `SchemaCache<unknown>` is expected

- [ ] **Step 3: Update describe-table.ts**

In `src/mcp/tools/describe-table.ts`, replace the import and signature:

```ts
import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
import type { ResourceCache } from '../../cache/resource-cache.js';
import { stableStringify } from '../../cache/stable-stringify.js';
import { runTool, type McpResult } from '../tool-helpers.js';
import { ServiceNowNotFoundError } from '../../errors.js';

export const describeTableInput = {
  name: z.string().describe('Table name (e.g. "incident", "cmdb_ci").'),
};

export interface DescribeTableTool {
  name: 'describe_table';
  description: string;
  inputShape: typeof describeTableInput;
  handler(input: { name: string }): Promise<McpResult>;
}

export function createDescribeTableTool(
  client: ServiceNowClient,
  cache: ResourceCache,
): DescribeTableTool {
  return {
    name: 'describe_table',
    description:
      'Describe a ServiceNow table: label, parent table, and field definitions (from sys_dictionary).',
    inputShape: describeTableInput,
    handler: (input) =>
      runTool(async () => {
        const key = stableStringify(input);
        const cached = await cache.get<unknown>('schema', key);
        if (cached !== undefined) return cached;

        const meta = await client.table.query<{
          name: string;
          label: string;
          super_class?: { display_value?: string };
        }>('sys_db_object', {
          sysparmQuery: `name=${input.name}`,
          fields: ['name', 'label', 'super_class'],
          limit: 1,
          displayValue: 'all',
        });
        const row = meta.records[0];
        if (!row) {
          throw new ServiceNowNotFoundError(
            404,
            { table: input.name },
            `table not found: ${input.name}`,
          );
        }
        const dict = await client.table.query<{
          element: string;
          column_label: string;
          internal_type?: { value?: string };
          reference?: { value?: string };
          mandatory: string;
          read_only: string;
        }>('sys_dictionary', {
          sysparmQuery: `name=${input.name}^elementISNOTEMPTY`,
          fields: [
            'element',
            'column_label',
            'internal_type',
            'reference',
            'mandatory',
            'read_only',
          ],
          limit: 1000,
          displayValue: 'all',
        });
        const out = {
          name: row.name,
          label: row.label,
          parent: row.super_class?.display_value ?? null,
          fields: dict.records.map((f) => ({
            name: f.element,
            label: f.column_label,
            type: f.internal_type?.value ?? 'unknown',
            reference: f.reference?.value || undefined,
            mandatory: f.mandatory === 'true',
            readOnly: f.read_only === 'true',
          })),
        };
        await cache.set('schema', key, out);
        return out;
      }),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/mcp/tools/describe-table.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/describe-table.ts src/mcp/tools/describe-table.test.ts
git commit -m "feat(cache): migrate describe_table to ResourceCache"
```

---

### Task 6: Migrate `list_tables` to `ResourceCache`

**Files:**

- Modify: `src/mcp/tools/list-tables.ts`
- Modify: `src/mcp/tools/list-tables.test.ts`

- [ ] **Step 1: Update the test file**

Write `src/mcp/tools/list-tables.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createListTablesTool } from './list-tables.js';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { createResourceCache } from '../../cache/resource-cache.js';

const DISABLED = {
  dbPath: ':memory:',
  ttlLongMs: 0,
  ttlMediumMs: 0,
  ttlShortMs: 0,
  maxEntries: 10,
};
const ENABLED = {
  dbPath: ':memory:',
  ttlLongMs: 60_000,
  ttlMediumMs: 60_000,
  ttlShortMs: 60_000,
  maxEntries: 10,
};

function clientWithTables(records: Record<string, unknown>[]): ServiceNowClient {
  return {
    table: { query: vi.fn(async () => ({ records, total: records.length })), getRecord: vi.fn() },
    aggregate: { aggregate: vi.fn() },
    attachment: { getAttachment: vi.fn() },
    report: { runSavedReport: vi.fn() },
    userContext: { getUserContext: vi.fn() },
  } as unknown as ServiceNowClient;
}

describe('list_tables tool', () => {
  it('returns the full catalog when no filter is provided', async () => {
    const client = clientWithTables([
      { name: 'incident', label: 'Incident', super_class: 'task' },
      { name: 'cmdb_ci', label: 'Configuration Item' },
    ]);
    const cache = createResourceCache(DISABLED);
    const tool = createListTablesTool(client, cache);
    const out = await tool.handler({});
    const text = (out.content?.[0] as { text: string }).text;
    expect(text).toContain('"incident"');
    expect(text).toContain('"cmdb_ci"');
  });

  it('filters case-insensitively against name and label', async () => {
    const client = clientWithTables([
      { name: 'incident', label: 'Incident' },
      { name: 'change_request', label: 'Change Request' },
      { name: 'cmdb_ci', label: 'Configuration Item' },
    ]);
    const cache = createResourceCache(DISABLED);
    const tool = createListTablesTool(client, cache);
    const out = await tool.handler({ filter: 'CHANGE' });
    const text = (out.content?.[0] as { text: string }).text;
    expect(text).toContain('change_request');
    expect(text).not.toContain('cmdb_ci');
  });
});

describe('createListTablesTool with cache', () => {
  it('caches the full table list and applies filter on the cached result', async () => {
    const query = vi.fn(async () => ({
      records: [
        { name: 'incident', label: 'Incident', super_class: 'task', sys_id: 'a' },
        { name: 'change_request', label: 'Change Request', super_class: 'task', sys_id: 'b' },
      ],
    }));
    const client = { table: { query } } as unknown as ServiceNowClient;
    const cache = createResourceCache(ENABLED);
    const tool = createListTablesTool(client, cache);

    await tool.handler({});
    await tool.handler({ filter: 'incident' });

    expect(query).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/mcp/tools/list-tables.test.ts`
Expected: FAIL — type mismatch between `ResourceCache` and the still-`SchemaCache`-typed `createListTablesTool`

- [ ] **Step 3: Update list-tables.ts**

Write `src/mcp/tools/list-tables.ts`:

```ts
import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
import type { ResourceCache } from '../../cache/resource-cache.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const listTablesInput = {
  filter: z
    .string()
    .optional()
    .describe('Case-insensitive substring matched against table name and label.'),
};

export interface CachedRow {
  name: string;
  label: string;
  super_class?: string;
}

const ALL_KEY = 'list_tables:all';

export interface ListTablesTool {
  name: 'list_tables';
  description: string;
  inputShape: typeof listTablesInput;
  handler(input: { filter?: string }): Promise<McpResult>;
}

export function createListTablesTool(
  client: ServiceNowClient,
  cache: ResourceCache,
): ListTablesTool {
  return {
    name: 'list_tables',
    description:
      'List ServiceNow tables visible to the authenticated user. Use the optional `filter` arg to narrow by name or label.',
    inputShape: listTablesInput,
    handler: (input) =>
      runTool(async () => {
        let rows = await cache.get<CachedRow[]>('catalog', ALL_KEY);
        if (!rows) {
          const out = await client.table.query<{
            name: string;
            label: string;
            super_class?: string;
            sys_id: string;
          }>('sys_db_object', {
            fields: ['name', 'label', 'super_class', 'sys_id'],
            limit: 10000,
            offset: 0,
          });
          rows = out.records.map(({ name, label, super_class }) => ({ name, label, super_class }));
          await cache.set('catalog', ALL_KEY, rows);
        }
        const f = input.filter?.toLowerCase();
        return f
          ? rows.filter(
              (r) => r.name?.toLowerCase().includes(f) || r.label?.toLowerCase().includes(f),
            )
          : rows;
      }),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/mcp/tools/list-tables.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/list-tables.ts src/mcp/tools/list-tables.test.ts
git commit -m "feat(cache): migrate list_tables to ResourceCache"
```

---

### Task 7: Cache the `servicenow://tables` resource

**Files:**

- Modify: `src/mcp/resources/tables.ts`
- Modify: `src/mcp/resources/tables.test.ts`

Today this resource always hits ServiceNow live — this task adds `catalog`-kind caching, keyed by its own fixed URI so it never collides with `list_tables`' `list_tables:all` key.

- [ ] **Step 1: Update the test file**

Write `src/mcp/resources/tables.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createTablesResource } from './tables.js';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { createResourceCache } from '../../cache/resource-cache.js';

const DISABLED = {
  dbPath: ':memory:',
  ttlLongMs: 0,
  ttlMediumMs: 0,
  ttlShortMs: 0,
  maxEntries: 10,
};
const ENABLED = {
  dbPath: ':memory:',
  ttlLongMs: 60_000,
  ttlMediumMs: 60_000,
  ttlShortMs: 60_000,
  maxEntries: 10,
};

function clientWithTables(): { client: ServiceNowClient; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({
    records: [
      { name: 'incident', label: 'Incident', super_class: 'task', sys_id: 'a' },
      { name: 'cmdb_ci', label: 'CI', sys_id: 'b' },
    ],
    total: 2,
  }));
  const client = {
    table: { query, getRecord: vi.fn() },
    aggregate: { aggregate: vi.fn() },
    attachment: { getAttachment: vi.fn() },
    report: { runSavedReport: vi.fn() },
    userContext: { getUserContext: vi.fn() },
  } as unknown as ServiceNowClient;
  return { client, query };
}

describe('tables resource', () => {
  it('returns ServiceNow tables as a JSON resource', async () => {
    const { client } = clientWithTables();
    const cache = createResourceCache(DISABLED);
    const resource = createTablesResource(client, cache);
    const out = await resource.read();
    expect(out.contents).toHaveLength(1);
    expect(out.contents[0]?.uri).toBe('servicenow://tables');
    expect(out.contents[0]?.mimeType).toBe('application/json');
    const payload = JSON.parse(out.contents[0]?.text ?? '');
    expect(payload).toEqual([
      { name: 'incident', label: 'Incident', super_class: 'task', sys_id: 'a' },
      { name: 'cmdb_ci', label: 'CI', sys_id: 'b' },
    ]);
  });
});

describe('tables resource with cache', () => {
  it('returns the cached result on second read without calling client.table.query', async () => {
    const { client, query } = clientWithTables();
    const cache = createResourceCache(ENABLED);
    const resource = createTablesResource(client, cache);

    await resource.read();
    await resource.read();

    expect(query).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/mcp/resources/tables.test.ts`
Expected: FAIL — `createTablesResource` doesn't accept a second `cache` argument yet

- [ ] **Step 3: Update tables.ts**

Write `src/mcp/resources/tables.ts`:

```ts
import type { ServiceNowClient } from '../../servicenow/client.js';
import type { ResourceCache } from '../../cache/resource-cache.js';

export interface ResourceContents {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}

export interface TablesResource {
  uri: 'servicenow://tables';
  name: 'tables';
  description: string;
  mimeType: 'application/json';
  read(): Promise<ResourceContents>;
}

const CACHE_KEY = 'servicenow://tables';

export function createTablesResource(
  client: ServiceNowClient,
  cache: ResourceCache,
): TablesResource {
  return {
    uri: 'servicenow://tables',
    name: 'tables',
    description: 'Live catalog of ServiceNow tables visible to the authenticated user.',
    mimeType: 'application/json',
    async read() {
      const cached = await cache.get<ResourceContents>('catalog', CACHE_KEY);
      if (cached !== undefined) return cached;

      const out = await client.table.query<{
        name: string;
        label: string;
        super_class?: string;
        sys_id: string;
      }>('sys_db_object', {
        fields: ['name', 'label', 'super_class', 'sys_id'],
        limit: 10000,
        offset: 0,
      });
      const text = JSON.stringify(
        out.records.map((r) => ({
          name: r.name,
          label: r.label,
          super_class: r.super_class,
          sys_id: r.sys_id,
        })),
        null,
        2,
      );
      const result: ResourceContents = {
        contents: [{ uri: 'servicenow://tables', mimeType: 'application/json', text }],
      };
      await cache.set('catalog', CACHE_KEY, result);
      return result;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/mcp/resources/tables.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/resources/tables.ts src/mcp/resources/tables.test.ts
git commit -m "feat(cache): cache the servicenow://tables resource"
```

---

### Task 8: Add caching to `get_record`

**Files:**

- Modify: `src/mcp/tools/get-record.ts`
- Modify: `src/mcp/tools/get-record.test.ts`

- [ ] **Step 1: Update the test file**

Write `src/mcp/tools/get-record.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createGetRecordTool } from './get-record.js';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { ServiceNowNotFoundError } from '../../errors.js';
import { createResourceCache } from '../../cache/resource-cache.js';

const DISABLED = {
  dbPath: ':memory:',
  ttlLongMs: 0,
  ttlMediumMs: 0,
  ttlShortMs: 0,
  maxEntries: 10,
};
const ENABLED = {
  dbPath: ':memory:',
  ttlLongMs: 60_000,
  ttlMediumMs: 60_000,
  ttlShortMs: 60_000,
  maxEntries: 10,
};

describe('get_record tool', () => {
  it('returns the record from TableApi.getRecord', async () => {
    const getRecord = vi.fn(async () => ({ sys_id: 'abc', number: 'INC1' }));
    const client = {
      table: { query: vi.fn(), getRecord },
      aggregate: { aggregate: vi.fn() },
      attachment: { getAttachment: vi.fn() },
      report: { runSavedReport: vi.fn() },
      userContext: { getUserContext: vi.fn() },
    } as unknown as ServiceNowClient;
    const cache = createResourceCache(DISABLED);
    const tool = createGetRecordTool(client, cache);
    const out = await tool.handler({
      table: 'incident',
      sys_id: 'abc',
      fields: ['sys_id', 'number'],
    });
    expect(getRecord).toHaveBeenCalledWith('incident', 'abc', ['sys_id', 'number']);
    expect(JSON.parse((out.content?.[0] as { text: string }).text)).toEqual({
      sys_id: 'abc',
      number: 'INC1',
    });
  });

  it('forwards ServiceNowNotFoundError as not_found', async () => {
    const getRecord = vi.fn(async () => {
      throw new ServiceNowNotFoundError(404, null, 'gone');
    });
    const client = {
      table: { query: vi.fn(), getRecord },
      aggregate: { aggregate: vi.fn() },
      attachment: { getAttachment: vi.fn() },
      report: { runSavedReport: vi.fn() },
      userContext: { getUserContext: vi.fn() },
    } as unknown as ServiceNowClient;
    const cache = createResourceCache(DISABLED);
    const tool = createGetRecordTool(client, cache);
    const out = await tool.handler({ table: 'incident', sys_id: 'missing' });
    expect(out.isError).toBe(true);
    expect((out.content?.[0] as { text: string }).text).toContain('not_found');
  });
});

describe('get_record tool with cache', () => {
  it('returns the cached result on second call without calling getRecord again', async () => {
    const getRecord = vi.fn(async () => ({ sys_id: 'abc', number: 'INC1' }));
    const client = {
      table: { query: vi.fn(), getRecord },
      aggregate: { aggregate: vi.fn() },
      attachment: { getAttachment: vi.fn() },
      report: { runSavedReport: vi.fn() },
      userContext: { getUserContext: vi.fn() },
    } as unknown as ServiceNowClient;
    const cache = createResourceCache(ENABLED);
    const tool = createGetRecordTool(client, cache);

    await tool.handler({ table: 'incident', sys_id: 'abc' });
    await tool.handler({ table: 'incident', sys_id: 'abc' });

    expect(getRecord).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/mcp/tools/get-record.test.ts`
Expected: FAIL — `createGetRecordTool` doesn't accept a `cache` argument yet

- [ ] **Step 3: Update get-record.ts**

Write `src/mcp/tools/get-record.ts`:

```ts
import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
import type { ResourceCache } from '../../cache/resource-cache.js';
import { stableStringify } from '../../cache/stable-stringify.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const getRecordInput = {
  table: z.string().describe('ServiceNow table name.'),
  sys_id: z.string().describe('The record sys_id.'),
  fields: z
    .array(z.string())
    .optional()
    .describe('Field allowlist. Omit to return all readable fields.'),
};

export interface GetRecordTool {
  name: 'get_record';
  description: string;
  inputShape: typeof getRecordInput;
  handler(input: { table: string; sys_id: string; fields?: string[] }): Promise<McpResult>;
}

export function createGetRecordTool(client: ServiceNowClient, cache: ResourceCache): GetRecordTool {
  return {
    name: 'get_record',
    description: 'Fetch a single ServiceNow record by table and sys_id.',
    inputShape: getRecordInput,
    handler: (input) =>
      runTool(async () => {
        const key = stableStringify(input);
        const cached = await cache.get('record', key);
        if (cached !== undefined) return cached;
        const out = await client.table.getRecord(input.table, input.sys_id, input.fields);
        await cache.set('record', key, out);
        return out;
      }),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/mcp/tools/get-record.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/get-record.ts src/mcp/tools/get-record.test.ts
git commit -m "feat(cache): add short-TTL caching to get_record"
```

---

### Task 9: Add caching to `query_table`

**Files:**

- Modify: `src/mcp/tools/query-table.ts`
- Modify: `src/mcp/tools/query-table.test.ts`

- [ ] **Step 1: Update the test file**

Write `src/mcp/tools/query-table.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createQueryTableTool } from './query-table.js';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { createResourceCache } from '../../cache/resource-cache.js';

const DISABLED = {
  dbPath: ':memory:',
  ttlLongMs: 0,
  ttlMediumMs: 0,
  ttlShortMs: 0,
  maxEntries: 10,
};
const ENABLED = {
  dbPath: ':memory:',
  ttlLongMs: 60_000,
  ttlMediumMs: 60_000,
  ttlShortMs: 60_000,
  maxEntries: 10,
};

describe('query_table tool', () => {
  it('passes inputs to TableApi.query and returns the result envelope', async () => {
    const query = vi.fn(async () => ({ records: [{ sys_id: '1' }], total: 100, next_offset: 1 }));
    const client = {
      table: { query, getRecord: vi.fn() },
      aggregate: { aggregate: vi.fn() },
      attachment: { getAttachment: vi.fn() },
      report: { runSavedReport: vi.fn() },
      userContext: { getUserContext: vi.fn() },
    } as unknown as ServiceNowClient;
    const cache = createResourceCache(DISABLED);
    const tool = createQueryTableTool(client, cache);
    const out = await tool.handler({
      table: 'incident',
      sysparm_query: 'priority=1',
      fields: ['sys_id', 'number'],
      limit: 1,
      offset: 0,
      display_value: 'true',
    });
    expect(query).toHaveBeenCalledWith('incident', {
      sysparmQuery: 'priority=1',
      fields: ['sys_id', 'number'],
      limit: 1,
      offset: 0,
      displayValue: 'true',
    });
    const payload = JSON.parse((out.content?.[0] as { text: string }).text);
    expect(payload).toEqual({ records: [{ sys_id: '1' }], total: 100, next_offset: 1 });
  });
});

describe('query_table tool with cache', () => {
  it('returns the cached result on second call with identical inputs without re-querying', async () => {
    const query = vi.fn(async () => ({ records: [{ sys_id: '1' }] }));
    const client = { table: { query } } as unknown as ServiceNowClient;
    const cache = createResourceCache(ENABLED);
    const tool = createQueryTableTool(client, cache);

    await tool.handler({ table: 'incident', limit: 10 });
    await tool.handler({ table: 'incident', limit: 10 });

    expect(query).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/mcp/tools/query-table.test.ts`
Expected: FAIL — `createQueryTableTool` doesn't accept a `cache` argument yet

- [ ] **Step 3: Update query-table.ts**

Write `src/mcp/tools/query-table.ts`:

```ts
import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
import type { ResourceCache } from '../../cache/resource-cache.js';
import { stableStringify } from '../../cache/stable-stringify.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const queryTableInput = {
  table: z.string().describe('ServiceNow table name (e.g. "incident").'),
  sysparm_query: z
    .string()
    .optional()
    .describe('Encoded query string (ServiceNow syntax, e.g. "priority=1^stateIN1,2").'),
  fields: z
    .array(z.string())
    .optional()
    .describe('Field allowlist. Omit to return all readable fields.'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Max rows in this page. Default 25. Large values inflate context cost.'),
  offset: z.number().int().nonnegative().optional().describe('Row offset for pagination.'),
  display_value: z
    .enum(['true', 'false', 'all'])
    .optional()
    .describe('ServiceNow display-value mode.'),
};

type Input = {
  table: string;
  sysparm_query?: string;
  fields?: string[];
  limit?: number;
  offset?: number;
  display_value?: 'true' | 'false' | 'all';
};

export interface QueryTableTool {
  name: 'query_table';
  description: string;
  inputShape: typeof queryTableInput;
  handler(input: Input): Promise<McpResult>;
}

export function createQueryTableTool(
  client: ServiceNowClient,
  cache: ResourceCache,
): QueryTableTool {
  return {
    name: 'query_table',
    description:
      'Query any ServiceNow table. Returns a page of records plus optional next_offset for pagination. Default limit is 25; large limits burn context, so request only what you need.',
    inputShape: queryTableInput,
    handler: (input) =>
      runTool(async () => {
        const key = stableStringify(input);
        const cached = await cache.get('record', key);
        if (cached !== undefined) return cached;

        const out = await client.table.query(input.table, {
          sysparmQuery: input.sysparm_query,
          fields: input.fields,
          limit: input.limit,
          offset: input.offset,
          displayValue: input.display_value,
        });
        const result: { records: unknown[]; total?: number; next_offset?: number } = {
          records: out.records,
        };
        if (out.total !== undefined) result.total = out.total;
        if (out.next_offset !== undefined) result.next_offset = out.next_offset;
        await cache.set('record', key, result);
        return result;
      }),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/mcp/tools/query-table.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/query-table.ts src/mcp/tools/query-table.test.ts
git commit -m "feat(cache): add short-TTL caching to query_table"
```

---

### Task 10: Add caching to `aggregate`

**Files:**

- Modify: `src/mcp/tools/aggregate.ts`
- Modify: `src/mcp/tools/aggregate.test.ts`

- [ ] **Step 1: Update the test file**

Write `src/mcp/tools/aggregate.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createAggregateTool } from './aggregate.js';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { createResourceCache } from '../../cache/resource-cache.js';

const DISABLED = {
  dbPath: ':memory:',
  ttlLongMs: 0,
  ttlMediumMs: 0,
  ttlShortMs: 0,
  maxEntries: 10,
};
const ENABLED = {
  dbPath: ':memory:',
  ttlLongMs: 60_000,
  ttlMediumMs: 60_000,
  ttlShortMs: 60_000,
  maxEntries: 10,
};

describe('aggregate tool', () => {
  it('forwards inputs to AggregateApi.aggregate', async () => {
    const aggregate = vi.fn(async () => [{ group: { priority: '1' }, value: 42 }]);
    const client = {
      table: { query: vi.fn(), getRecord: vi.fn() },
      aggregate: { aggregate },
      attachment: { getAttachment: vi.fn() },
      report: { runSavedReport: vi.fn() },
      userContext: { getUserContext: vi.fn() },
    } as unknown as ServiceNowClient;
    const cache = createResourceCache(DISABLED);
    const tool = createAggregateTool(client, cache);
    const out = await tool.handler({
      table: 'incident',
      operation: 'count',
      group_by: ['priority'],
      sysparm_query: 'active=true',
    });
    expect(aggregate).toHaveBeenCalledWith('incident', {
      operation: 'count',
      field: undefined,
      groupBy: ['priority'],
      sysparmQuery: 'active=true',
    });
    expect(JSON.parse((out.content?.[0] as { text: string }).text)).toEqual([
      { group: { priority: '1' }, value: 42 },
    ]);
  });

  it('emits client_error when API throws for non-count without field', async () => {
    const aggregate = vi.fn(async () => {
      throw new Error('field required');
    });
    const client = {
      table: { query: vi.fn(), getRecord: vi.fn() },
      aggregate: { aggregate },
      attachment: { getAttachment: vi.fn() },
      report: { runSavedReport: vi.fn() },
      userContext: { getUserContext: vi.fn() },
    } as unknown as ServiceNowClient;
    const cache = createResourceCache(DISABLED);
    const tool = createAggregateTool(client, cache);
    const out = await tool.handler({ table: 'incident', operation: 'sum' });
    expect(out.isError).toBe(true);
    expect((out.content?.[0] as { text: string }).text).toContain('internal_error');
  });
});

describe('aggregate tool with cache', () => {
  it('returns the cached result on second call with identical inputs without re-aggregating', async () => {
    const aggregate = vi.fn(async () => [{ value: 42 }]);
    const client = { aggregate: { aggregate } } as unknown as ServiceNowClient;
    const cache = createResourceCache(ENABLED);
    const tool = createAggregateTool(client, cache);

    await tool.handler({ table: 'incident', operation: 'count' });
    await tool.handler({ table: 'incident', operation: 'count' });

    expect(aggregate).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/mcp/tools/aggregate.test.ts`
Expected: FAIL — `createAggregateTool` doesn't accept a `cache` argument yet

- [ ] **Step 3: Update aggregate.ts**

Write `src/mcp/tools/aggregate.ts`:

```ts
import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
import type { ResourceCache } from '../../cache/resource-cache.js';
import { stableStringify } from '../../cache/stable-stringify.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const aggregateInput = {
  table: z.string().describe('ServiceNow table name.'),
  operation: z.enum(['count', 'avg', 'sum', 'min', 'max']).describe('Aggregate operation.'),
  field: z.string().optional().describe('Required for avg/sum/min/max. Ignored for count.'),
  group_by: z
    .array(z.string())
    .optional()
    .describe('Group rows by these fields before aggregating.'),
  sysparm_query: z
    .string()
    .optional()
    .describe('Optional ServiceNow encoded query to filter rows.'),
};

type Input = {
  table: string;
  operation: 'count' | 'avg' | 'sum' | 'min' | 'max';
  field?: string;
  group_by?: string[];
  sysparm_query?: string;
};

export interface AggregateTool {
  name: 'aggregate';
  description: string;
  inputShape: typeof aggregateInput;
  handler(input: Input): Promise<McpResult>;
}

export function createAggregateTool(client: ServiceNowClient, cache: ResourceCache): AggregateTool {
  return {
    name: 'aggregate',
    description:
      'Run a ServiceNow aggregate query (count/avg/sum/min/max) optionally grouped by fields.',
    inputShape: aggregateInput,
    handler: (input) =>
      runTool(async () => {
        const key = stableStringify(input);
        const cached = await cache.get('aggregate', key);
        if (cached !== undefined) return cached;

        const out = await client.aggregate.aggregate(input.table, {
          operation: input.operation,
          field: input.field,
          groupBy: input.group_by,
          sysparmQuery: input.sysparm_query,
        });
        await cache.set('aggregate', key, out);
        return out;
      }),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/mcp/tools/aggregate.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/aggregate.ts src/mcp/tools/aggregate.test.ts
git commit -m "feat(cache): add short-TTL caching to aggregate"
```

---

### Task 11: Add caching to `run_saved_report`

**Files:**

- Modify: `src/mcp/tools/run-saved-report.ts`
- Modify: `src/mcp/tools/run-saved-report.test.ts`

- [ ] **Step 1: Update the test file**

Write `src/mcp/tools/run-saved-report.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createRunSavedReportTool } from './run-saved-report.js';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { createResourceCache } from '../../cache/resource-cache.js';

const DISABLED = {
  dbPath: ':memory:',
  ttlLongMs: 0,
  ttlMediumMs: 0,
  ttlShortMs: 0,
  maxEntries: 10,
};
const ENABLED = {
  dbPath: ':memory:',
  ttlLongMs: 60_000,
  ttlMediumMs: 60_000,
  ttlShortMs: 60_000,
  maxEntries: 10,
};

describe('run_saved_report tool', () => {
  it('delegates to ReportApi.runSavedReport', async () => {
    const runSavedReport = vi.fn(async () => ({
      records: [{ number: 'INC1' }],
      total: 1,
      definition: { table: 'incident', columns: ['number'] },
    }));
    const client = {
      table: { query: vi.fn(), getRecord: vi.fn() },
      aggregate: { aggregate: vi.fn() },
      attachment: { getAttachment: vi.fn() },
      report: { runSavedReport },
      userContext: { getUserContext: vi.fn() },
    } as unknown as ServiceNowClient;
    const cache = createResourceCache(DISABLED);
    const tool = createRunSavedReportTool(client, cache);
    const out = await tool.handler({ report_sys_id: 'rep1', limit: 10, offset: 0 });
    expect(runSavedReport).toHaveBeenCalledWith('rep1', { limit: 10, offset: 0 });
    const payload = JSON.parse((out.content?.[0] as { text: string }).text);
    expect(payload.definition).toEqual({ table: 'incident', columns: ['number'] });
  });
});

describe('run_saved_report tool with cache', () => {
  it('returns the cached result on second call with identical inputs without re-running the report', async () => {
    const runSavedReport = vi.fn(async () => ({ records: [], total: 0 }));
    const client = { report: { runSavedReport } } as unknown as ServiceNowClient;
    const cache = createResourceCache(ENABLED);
    const tool = createRunSavedReportTool(client, cache);

    await tool.handler({ report_sys_id: 'rep1' });
    await tool.handler({ report_sys_id: 'rep1' });

    expect(runSavedReport).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/mcp/tools/run-saved-report.test.ts`
Expected: FAIL — `createRunSavedReportTool` doesn't accept a `cache` argument yet

- [ ] **Step 3: Update run-saved-report.ts**

Write `src/mcp/tools/run-saved-report.ts`:

```ts
import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
import type { ResourceCache } from '../../cache/resource-cache.js';
import { stableStringify } from '../../cache/stable-stringify.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const runSavedReportInput = {
  report_sys_id: z
    .string()
    .describe('sys_id of a row in sys_report (list-type reports only in v1).'),
  limit: z.number().int().positive().optional().describe('Max rows in this page. Default 25.'),
  offset: z.number().int().nonnegative().optional().describe('Row offset for pagination.'),
};

export interface RunSavedReportTool {
  name: 'run_saved_report';
  description: string;
  inputShape: typeof runSavedReportInput;
  handler(input: { report_sys_id: string; limit?: number; offset?: number }): Promise<McpResult>;
}

export function createRunSavedReportTool(
  client: ServiceNowClient,
  cache: ResourceCache,
): RunSavedReportTool {
  return {
    name: 'run_saved_report',
    description:
      'Execute a saved ServiceNow report (list type) by sys_id. Returns the resulting records plus the report definition.',
    inputShape: runSavedReportInput,
    handler: (input) =>
      runTool(async () => {
        const key = stableStringify(input);
        const cached = await cache.get('report', key);
        if (cached !== undefined) return cached;

        const out = await client.report.runSavedReport(input.report_sys_id, {
          limit: input.limit,
          offset: input.offset,
        });
        await cache.set('report', key, out);
        return out;
      }),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/mcp/tools/run-saved-report.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/run-saved-report.ts src/mcp/tools/run-saved-report.test.ts
git commit -m "feat(cache): add short-TTL caching to run_saved_report"
```

---

### Task 12: Add caching to `get_user_context`

**Files:**

- Modify: `src/mcp/tools/get-user-context.ts`
- Modify: `src/mcp/tools/get-user-context.test.ts`

- [ ] **Step 1: Update the test file**

Write `src/mcp/tools/get-user-context.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createGetUserContextTool } from './get-user-context.js';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { createResourceCache } from '../../cache/resource-cache.js';

const DISABLED = {
  dbPath: ':memory:',
  ttlLongMs: 0,
  ttlMediumMs: 0,
  ttlShortMs: 0,
  maxEntries: 10,
};
const ENABLED = {
  dbPath: ':memory:',
  ttlLongMs: 60_000,
  ttlMediumMs: 60_000,
  ttlShortMs: 60_000,
  maxEntries: 10,
};

describe('get_user_context tool', () => {
  it('returns the result of UserContextApi.getUserContext', async () => {
    const getUserContext = vi.fn(async () => ({
      sys_id: 'u1',
      user_name: 'jagaitera',
      name: 'J',
      email: 'j@x',
      roles: ['admin'],
      groups: [],
    }));
    const client = {
      table: { query: vi.fn(), getRecord: vi.fn() },
      aggregate: { aggregate: vi.fn() },
      attachment: { getAttachment: vi.fn() },
      report: { runSavedReport: vi.fn() },
      userContext: { getUserContext },
    } as unknown as ServiceNowClient;
    const cache = createResourceCache(DISABLED);
    const tool = createGetUserContextTool(client, cache);
    const out = await tool.handler({});
    expect(getUserContext).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((out.content?.[0] as { text: string }).text);
    expect(payload.user_name).toBe('jagaitera');
    expect(payload.roles).toEqual(['admin']);
  });
});

describe('get_user_context tool with cache', () => {
  it('returns the cached result on second call without calling getUserContext again', async () => {
    const getUserContext = vi.fn(async () => ({ sys_id: 'u1', user_name: 'jagaitera' }));
    const client = { userContext: { getUserContext } } as unknown as ServiceNowClient;
    const cache = createResourceCache(ENABLED);
    const tool = createGetUserContextTool(client, cache);

    await tool.handler({});
    await tool.handler({});

    expect(getUserContext).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/mcp/tools/get-user-context.test.ts`
Expected: FAIL — `createGetUserContextTool` doesn't accept a `cache` argument yet

- [ ] **Step 3: Update get-user-context.ts**

Write `src/mcp/tools/get-user-context.ts`:

```ts
import type { ServiceNowClient } from '../../servicenow/client.js';
import type { ResourceCache } from '../../cache/resource-cache.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const getUserContextInput = {} as const;

const CACHE_KEY = 'get_user_context:singleton';

export interface GetUserContextTool {
  name: 'get_user_context';
  description: string;
  inputShape: typeof getUserContextInput;
  handler(input: Record<string, never>): Promise<McpResult>;
}

export function createGetUserContextTool(
  client: ServiceNowClient,
  cache: ResourceCache,
): GetUserContextTool {
  return {
    name: 'get_user_context',
    description:
      'Return the authenticated user (user_name, sys_id, name, email) plus their roles and groups.',
    inputShape: getUserContextInput,
    handler: () =>
      runTool(async () => {
        const cached = await cache.get('user_context', CACHE_KEY);
        if (cached !== undefined) return cached;
        const out = await client.userContext.getUserContext();
        await cache.set('user_context', CACHE_KEY, out);
        return out;
      }),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/mcp/tools/get-user-context.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/get-user-context.ts src/mcp/tools/get-user-context.test.ts
git commit -m "feat(cache): add medium-TTL caching to get_user_context"
```

---

### Task 13: Rewire `server.ts`

**Files:**

- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/server.test.ts`

Every tool constructor now takes a `ResourceCache` (except `get_attachment`, which stays uncached), and there's a 9th tool (`clear_cache`) plus the now-cached `tables` resource.

- [ ] **Step 1: Update the test file**

Write `src/mcp/server.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createMcpServer, createServerCaches } from './server.js';
import type { ServiceNowClient } from '../servicenow/client.js';

function fakeClient(): ServiceNowClient {
  return {
    table: { query: vi.fn(async () => ({ records: [], total: 0 })), getRecord: vi.fn() },
    aggregate: { aggregate: vi.fn() },
    attachment: { getAttachment: vi.fn() },
    report: { runSavedReport: vi.fn() },
    userContext: { getUserContext: vi.fn() },
  } as unknown as ServiceNowClient;
}

const DISABLED_CACHE_CONFIG = {
  dbPath: ':memory:',
  ttlLongMs: 0,
  ttlMediumMs: 0,
  ttlShortMs: 0,
  maxEntries: 1,
};

describe('createMcpServer', () => {
  it('registers the 9 tools and the tables resource', () => {
    const server = createMcpServer(fakeClient(), createServerCaches(DISABLED_CACHE_CONFIG));
    // McpServer exposes lower-level Server via .server. We just confirm it built.
    expect(server.server).toBeDefined();
    // Indirect check: introspect registered tools via the internal map (test-only access).
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(tools).sort()).toEqual(
      [
        'aggregate',
        'clear_cache',
        'describe_table',
        'get_attachment',
        'get_record',
        'get_user_context',
        'list_tables',
        'query_table',
        'run_saved_report',
      ].sort(),
    );
    const resources = (
      server as unknown as { _registeredResources: Record<string, { name: string }> }
    )._registeredResources;
    expect(Object.values(resources).map((r) => r.name)).toContain('tables');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/mcp/server.test.ts`
Expected: FAIL — `createServerCaches` still expects the old `{ ttlMs, maxEntries }` shape and returns `ServerCaches`, not a `ResourceCache`

- [ ] **Step 3: Update server.ts**

Write `src/mcp/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceNowClient } from '../servicenow/client.js';
import type { CacheConfig } from '../config.js';
import {
  createResourceCache,
  createNoopResourceCache,
  type ResourceCache,
} from '../cache/resource-cache.js';
import { createListTablesTool } from './tools/list-tables.js';
import { createDescribeTableTool } from './tools/describe-table.js';
import { createQueryTableTool } from './tools/query-table.js';
import { createGetRecordTool } from './tools/get-record.js';
import { createGetAttachmentTool } from './tools/get-attachment.js';
import { createAggregateTool } from './tools/aggregate.js';
import { createRunSavedReportTool } from './tools/run-saved-report.js';
import { createGetUserContextTool } from './tools/get-user-context.js';
import { createClearCacheTool } from './tools/clear-cache.js';
import { createTablesResource } from './resources/tables.js';

export function createServerCaches(cacheConfig: CacheConfig): ResourceCache {
  return createResourceCache(cacheConfig);
}

export function createNoopServerCaches(): ResourceCache {
  return createNoopResourceCache();
}

export function createMcpServer(client: ServiceNowClient, cache: ResourceCache): McpServer {
  // NOTE: keep in sync with package.json "version". tsconfig rootDir=./src blocks importing it directly.
  const server = new McpServer({ name: 'snow-mcp', version: '1.1.0' });

  for (const tool of [
    createListTablesTool(client, cache),
    createDescribeTableTool(client, cache),
    createQueryTableTool(client, cache),
    createGetRecordTool(client, cache),
    createGetAttachmentTool(client),
    createAggregateTool(client, cache),
    createRunSavedReportTool(client, cache),
    createGetUserContextTool(client, cache),
    createClearCacheTool(cache),
  ]) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputShape },
      (async (args: Record<string, unknown>) =>
        (await tool.handler(args as never)) as unknown as CallToolResult) as never,
    );
  }

  const tables = createTablesResource(client, cache);
  server.registerResource(
    tables.name,
    tables.uri,
    { description: tables.description, mimeType: tables.mimeType },
    (async () => (await tables.read()) as unknown as ReadResourceResult) as never,
  );

  return server;
}
```

`createNoopServerCaches` is kept as a thin re-export for test/caller convenience even though `main.ts` no longer needs it after Task 14.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/mcp/server.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts src/mcp/server.test.ts
git commit -m "feat(cache): wire ResourceCache and clear_cache into createMcpServer"
```

---

### Task 14: Rewire `main.ts` — both transports cache

**Files:**

- Modify: `src/main.ts`
- Modify: `src/main.test.ts`

This is the change that reverses the "stdio is stateless" design: both the stdio and HTTP branches (and the `buildServer()` test helper) now call `createServerCaches(config.cache)` instead of stdio being forced to `createNoopServerCaches()`.

- [ ] **Step 1: Update the test file**

In `src/main.test.ts`, add `CACHE_DB_PATH: ':memory:'` to every env fixture that reaches cache creation (all except the empty-env `ConfigError` case), and bump the tool count from 8 to 9:

```ts
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildServer } from './main.js';

describe('buildServer', () => {
  it('throws ConfigError when env is empty', () => {
    expect(() => buildServer({})).toThrow(/Missing required configuration/);
  });

  it('builds a connectable McpServer when env is valid', () => {
    const { serverFactory } = buildServer({
      SNOW_INSTANCE_URL: 'https://example.service-now.com',
      SNOW_OAUTH_TOKEN: 't',
      CACHE_DB_PATH: ':memory:',
    });
    // buildServer always returns a factory; calling it yields the McpServer instance.
    expect(serverFactory()).toBeInstanceOf(McpServer);
  });

  it('registers all 9 tools', () => {
    const { serverFactory } = buildServer({
      SNOW_INSTANCE_URL: 'https://example.service-now.com',
      SNOW_OAUTH_TOKEN: 't',
      CACHE_DB_PATH: ':memory:',
    });
    const server = serverFactory();
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(tools)).toHaveLength(9);
  });

  it('returns a ServerConfig with transport=stdio by default', () => {
    const { config } = buildServer({
      SNOW_INSTANCE_URL: 'https://example.service-now.com',
      SNOW_OAUTH_TOKEN: 't',
      CACHE_DB_PATH: ':memory:',
    });
    expect(config.transport.kind).toBe('stdio');
  });

  it('throws when MCP_TRANSPORT=http (HTTP path is wired only in main())', () => {
    expect(() =>
      buildServer({
        SNOW_INSTANCE_URL: 'https://example.service-now.com',
        SNOW_OAUTH_TOKEN: 't',
        MCP_TRANSPORT: 'http',
        MCP_AUTH_TOKEN: 'test-auth-token',
      }),
    ).toThrow(/buildServer\(\) does not support MCP_TRANSPORT=http/);
  });
});
```

`CACHE_DB_PATH: ':memory:'` matters here: without it, `buildServer()` would fall back to the default `.cache/snow-mcp.sqlite` and unit tests would create a real file relative to the test-runner's cwd. The `MCP_TRANSPORT=http` case throws before reaching cache creation, so it doesn't need the override.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/main.test.ts`
Expected: FAIL — `registers all 9 tools` still sees 8 (stdio is still forced to noop caches); typecheck will also flag `createNoopServerCaches` import going unused once Step 3 lands

- [ ] **Step 3: Update main.ts**

Write `src/main.ts`:

```ts
import { loadConfig, type ServerConfig } from './config.js';
import { createServiceNowClient } from './servicenow/client.js';
import { createMcpServer, createServerCaches } from './mcp/server.js';
import { connectTransport } from './mcp/transport/index.js';
import { redactSecrets } from './log-redact.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function buildServer(env: NodeJS.ProcessEnv = process.env): {
  serverFactory: () => McpServer;
  config: ServerConfig;
} {
  const config = loadConfig(env);
  const client = createServiceNowClient(config);

  if (config.transport.kind === 'http') {
    const err = new Error(
      'buildServer() does not support MCP_TRANSPORT=http — the HTTP path requires per-request server instances and is wired only in main(). Use stdio transport for buildServer() in tests, or invoke main() directly.',
    );
    err.name = 'UnsupportedTransportError';
    throw err;
  }

  const cache = createServerCaches(config.cache);
  const server = createMcpServer(client, cache);
  return { serverFactory: () => server, config };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const snowClient = createServiceNowClient(config);
  const cache = createServerCaches(config.cache);

  if (config.transport.kind === 'http') {
    // Cache is created once and shared across per-request server instances via closure.
    await connectTransport(() => createMcpServer(snowClient, cache), config.transport);
    return;
  }

  const server = createMcpServer(snowClient, cache);
  await connectTransport(() => server, config.transport);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    const raw = err instanceof Error ? err.message : String(err);
    console.error(redactSecrets(raw));
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/main.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/main.test.ts
git commit -m "feat(cache): enable caching for stdio transport, not just HTTP"
```

---

### Task 15: Delete the old `schema-cache.ts`

**Files:**

- Delete: `src/servicenow/schema-cache.ts`
- Delete: `src/servicenow/schema-cache.test.ts`

- [ ] **Step 1: Confirm nothing still imports it**

Run: `grep -rn "schema-cache" src --include="*.ts"`
Expected: no output (all references were removed in Tasks 5, 6, 13)

- [ ] **Step 2: Delete both files**

```bash
git rm src/servicenow/schema-cache.ts src/servicenow/schema-cache.test.ts
```

- [ ] **Step 3: Run the full test suite**

Run: `yarn test`
Expected: PASS — all suites green, no references to the deleted files

- [ ] **Step 4: Run typecheck**

Run: `yarn typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git commit -m "chore(cache): remove the old lru-cache-based SchemaCache"
```

---

### Task 16: Docker — writable cache directory in the nonroot image

**Files:**

- Modify: `Dockerfile`

- [ ] **Step 1: Add the data directory and env default**

In `Dockerfile`, in the runtime stage, after the existing `WORKDIR /app` and before `EXPOSE 17880`, add:

```dockerfile
WORKDIR /app/data
ENV CACHE_DB_PATH=/app/data/cache.sqlite
WORKDIR /app
```

The extra `WORKDIR /app/data` line creates that directory owned by the distroless `:nonroot` image's default user (no shell/`mkdir`/`chown` available in this stage), then `WORKDIR /app` switches the working directory back to `/app` so `CMD ["dist/main.js"]` still resolves relatively the way it did before.

The full runtime stage should read:

```dockerfile
# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM gcr.io/distroless/nodejs24-debian12:nonroot

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules_prod ./node_modules
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_HOST=0.0.0.0
ENV MCP_HTTP_PORT=17880

WORKDIR /app/data
ENV CACHE_DB_PATH=/app/data/cache.sqlite
WORKDIR /app

EXPOSE 17880

# The `:nonroot` base tag already runs as the nonroot user; ENTRYPOINT is
# inherited as ["/nodejs/bin/node"], so CMD just needs the script path.
CMD ["dist/main.js"]
```

- [ ] **Step 2: Build the image locally and verify the container can write the cache file**

Run: `docker build -t snow-mcp:cache-test .`
Expected: build succeeds

Run:

```bash
docker run --rm -e SNOW_INSTANCE_URL=https://example.service-now.com -e SNOW_OAUTH_TOKEN=t \
  --entrypoint /nodejs/bin/node snow-mcp:cache-test -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('/app/data/cache.sqlite');
    db.exec('CREATE TABLE t (k TEXT)');
    console.log('writable');
  "
```

Expected: prints `writable` with no permission errors — confirms `/app/data` is writable by the nonroot runtime user

- [ ] **Step 3: Remove the test image**

```bash
docker rmi snow-mcp:cache-test
```

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "feat(docker): create a writable /app/data dir for the sqlite cache"
```

---

### Task 17: `.gitignore` — exclude the cache file

**Files:**

- Modify: `.gitignore`

- [ ] **Step 1: Add cache file patterns**

Add to `.gitignore` (after the existing `.env.local` line):

```
*.sqlite
*.sqlite3
.cache/
```

The full file should read:

```
node_modules/
dist/
*.log
.env
.env.local
.DS_Store
CLAUDE.local.md
*.sqlite
*.sqlite3
.cache/
```

- [ ] **Step 2: Verify a local cache file would actually be ignored**

Run: `mkdir -p .cache && touch .cache/snow-mcp.sqlite && git status --short .cache/`
Expected: no output (nothing untracked reported)

Run: `rm -rf .cache`

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore the local sqlite cache file"
```

---

### Task 18: `.env.example`, `docker-compose.yml`, `docker-compose.ghcr.yml`

**Files:**

- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.ghcr.yml`

Note: this repo's hooks may block automated edits to `.env.*` paths (seen previously when adding `SNOW_REQUEST_TIMEOUT_MS`). If the `Edit`/`Write` tool is denied on `.env.example`, apply this diff manually.

- [ ] **Step 1: Update .env.example**

Remove the `SCHEMA_CACHE_TTL_MS` and `SCHEMA_CACHE_MAX_ENTRIES` lines (with their comments) and replace with:

```
# Resource cache (node:sqlite, both transports). Set any tier to 0 to disable it.
CACHE_TTL_LONG_MS=3600000
CACHE_TTL_MEDIUM_MS=900000
CACHE_TTL_SHORT_MS=45000
CACHE_MAX_ENTRIES=1000
CACHE_DB_PATH=.cache/snow-mcp.sqlite
```

- [ ] **Step 2: Update docker-compose.yml**

Replace:

```yaml
SCHEMA_CACHE_TTL_MS: ${SCHEMA_CACHE_TTL_MS:-}
SCHEMA_CACHE_MAX_ENTRIES: ${SCHEMA_CACHE_MAX_ENTRIES:-}
```

with:

```yaml
CACHE_TTL_LONG_MS: ${CACHE_TTL_LONG_MS:-}
CACHE_TTL_MEDIUM_MS: ${CACHE_TTL_MEDIUM_MS:-}
CACHE_TTL_SHORT_MS: ${CACHE_TTL_SHORT_MS:-}
CACHE_MAX_ENTRIES: ${CACHE_MAX_ENTRIES:-}
CACHE_DB_PATH: ${CACHE_DB_PATH:-}
```

- [ ] **Step 3: Update docker-compose.ghcr.yml**

Apply the same replacement as Step 2 to `docker-compose.ghcr.yml` (it has the identical `SCHEMA_CACHE_*` lines).

- [ ] **Step 4: Verify no remaining SCHEMA_CACHE references**

Run: `grep -rn "SCHEMA_CACHE" . --include="*.yml" --include="*.example" 2>/dev/null`
Expected: no output

- [ ] **Step 5: Commit**

```bash
git add .env.example docker-compose.yml docker-compose.ghcr.yml
git commit -m "chore(config): swap SCHEMA_CACHE_* for tiered CACHE_* env vars"
```

---

### Task 19: Remove `lru-cache` and update `package.json`

**Files:**

- Modify: `package.json`
- Modify: `yarn.lock`

- [ ] **Step 1: Remove the dependency**

```bash
yarn remove lru-cache
```

Expected: `lru-cache` is gone from `dependencies` in `package.json`, and `yarn.lock` is updated

- [ ] **Step 2: Run typecheck and the full test suite**

Run: `yarn typecheck && yarn test`
Expected: both PASS — nothing in `src/` imports `lru-cache` anymore (confirmed by Task 15's grep)

- [ ] **Step 3: Commit**

```bash
git add package.json yarn.lock
git commit -m "chore(deps): remove lru-cache, replaced by node:sqlite"
```

---

### Task 20: Update README

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Replace the "Schema cache" section**

Replace the section starting at `### Schema cache` (currently lines 185–194) with:

```markdown
### Resource cache

`describe_table`, `list_tables`, `query_table`, `get_record`, `aggregate`,
`run_saved_report`, `get_user_context`, and the `servicenow://tables`
resource are all cached in a local `node:sqlite` database — on **both**
stdio and HTTP transports. `get_attachment` is never cached (binary,
potentially large). The cache file is local to the running container or
process, gitignored, and safe to delete at any time; it is never treated
as a source of truth.

Three TTL tiers, each independently disabled by setting it to `0`:

| Variable              | Default                  | Tier applies to                                                                      |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| `CACHE_TTL_LONG_MS`   | `3600000`                | `describe_table`, `list_tables`, `servicenow://tables` (1h)                          |
| `CACHE_TTL_MEDIUM_MS` | `900000`                 | `get_user_context` (15m)                                                             |
| `CACHE_TTL_SHORT_MS`  | `45000`                  | `query_table`, `get_record`, `aggregate`, `run_saved_report` (45s)                   |
| `CACHE_MAX_ENTRIES`   | `1000`                   | Global row cap across all cached kinds.                                              |
| `CACHE_DB_PATH`       | `.cache/snow-mcp.sqlite` | Sqlite file location. In the Docker image this defaults to `/app/data/cache.sqlite`. |

Call the `clear_cache` tool to force a fresh read before the TTL expires —
pass no arguments to clear everything, or `{ "kind": "record" }` (etc.) to
scope the clear to one cache kind (`schema`, `catalog`, `user_context`,
`record`, `aggregate`, `report`).
```

- [ ] **Step 2: Update the Tools section header and add clear_cache docs**

The `## Tools` section (currently starting at line 396) already says "All tools are read-only." Insert a new subsection after `### get_user_context` (before the `## Resources` heading, currently line 493):

```markdown
### `clear_cache`

Clear cached ServiceNow data so the next matching read is fetched live.
Purely local — never touches the ServiceNow API.

| Arg    | Type                                                                      | Required | Description                                |
| ------ | ------------------------------------------------------------------------- | -------- | ------------------------------------------ |
| `kind` | `schema` / `catalog` / `user_context` / `record` / `aggregate` / `report` | no       | Limit the clear to one kind. Omit for all. |

Returns `{ clearedCount }`.
```

- [ ] **Step 3: Update the file-tree comment**

Replace the line:

```
│   │   ├── schema-cache.ts   # TTL+LRU cache used by describe_table/list_tables
```

with:

```

```

(remove the line entirely — `schema-cache.ts` no longer exists) and add, in the `cache/` block near `mcp/`:

```
│   ├── cache/
│   │   ├── resource-cache.ts # node:sqlite cache, tiered TTLs, used by every cacheable tool
│   │   └── stable-stringify.ts
```

right after the `servicenow/` block's closing `└── …` line and before `└── mcp/`.

- [ ] **Step 4: Spot-check the rendered README**

Run: `grep -n "SCHEMA_CACHE\|stdio is stateless\|schema-cache.ts" README.md`
Expected: no output — every stale reference is gone

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): document the sqlite resource cache and clear_cache tool"
```

---

### Task 21: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `yarn test`
Expected: PASS — every suite green

- [ ] **Step 2: Typecheck**

Run: `yarn typecheck`
Expected: PASS, no errors

- [ ] **Step 3: Lint**

Run: `yarn lint`
Expected: PASS, no errors

- [ ] **Step 4: Format check**

Run: `yarn format:check`
Expected: PASS (run `yarn format` first and commit separately if it reports diffs)

- [ ] **Step 5: Confirm no stray sqlite file was left in the repo**

Run: `git status --short`
Expected: clean working tree (no untracked `.sqlite`/`.cache/` files — Task 17 already verified `.gitignore` catches them, this is a final sanity check)
