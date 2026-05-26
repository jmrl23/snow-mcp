# snow-mcp v1.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land three sequential feature branches on top of v1.0.0: GitHub Actions CI, an in-memory TTL schema cache for `describe_table` / `list_tables`, and OAuth client_credentials + Streamable HTTP transport. Read-only contract preserved; stdio + basic-auth remain defaults.

**Architecture:** One workflow file for CI. A generic `SchemaCache<T>` wrapped around the two slow tool handlers in `src/mcp/tools/`. An `AuthProvider` interface with three implementations (basic, static bearer, OAuth client_credentials) replacing the inline `buildAuthHeader` in `src/http/client.ts`, plus a transport factory in `src/mcp/transport/` selected by env. Auth selection stays implicit (priority: client_credentials > token > basic).

**Tech Stack:** TypeScript (ESM, Node 24), Vitest, `@modelcontextprotocol/sdk`, manual `ConfigError`-style validation (no Zod for config), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-05-26-ci-oauth-http-cache-design.md`

**Branch order (each is a feature branch off `main`, merged before the next starts):**

1. `feat/ci` — Tasks 1–2
2. `feat/schema-cache` — Tasks 3–9
3. `feat/oauth-and-http` — Tasks 10–22

Each branch must end with `yarn typecheck && yarn lint && yarn test` all passing.

---

## Branch 1: `feat/ci`

### Task 1: Add CI workflow

**Files:**

- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/ci
```

- [ ] **Step 2: Create the workflow file**

```yaml
# .github/workflows/ci.yml
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    name: typecheck + lint + test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: yarn
      - run: yarn install --frozen-lockfile
      - run: yarn typecheck
      - run: yarn lint
      - run: yarn test
```

- [ ] **Step 3: Verify locally that the three commands still pass**

Run: `yarn install --frozen-lockfile && yarn typecheck && yarn lint && yarn test`
Expected: all four commands exit 0; test output ends with `Tests  74 passed`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow (typecheck, lint, test on Node 24)"
```

### Task 2: Merge `feat/ci` into `main`

- [ ] **Step 1: Push the branch (optional, only if a remote is configured)**

```bash
git remote -v
# If a remote is configured, push:
git push -u origin feat/ci
```

If there is no remote, skip the push — the branch lives locally.

- [ ] **Step 2: Merge into main**

```bash
git checkout main
git merge --no-ff feat/ci -m "Merge feat/ci: GitHub Actions CI workflow"
```

- [ ] **Step 3: Verify clean state**

Run: `git status`
Expected: `nothing to commit, working tree clean`.

---

## Branch 2: `feat/schema-cache`

### Task 3: Create the generic schema cache module (test first)

**Files:**

- Create: `src/servicenow/schema-cache.ts`
- Create: `src/servicenow/schema-cache.test.ts`

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/schema-cache
```

- [ ] **Step 2: Write the failing tests**

Create `src/servicenow/schema-cache.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createSchemaCache } from './schema-cache.js';

describe('createSchemaCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns set value on get within ttl', () => {
    const cache = createSchemaCache<number>({ ttlMs: 1000, maxEntries: 10 });
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
  });

  it('returns undefined when entry has expired', () => {
    const cache = createSchemaCache<number>({ ttlMs: 1000, maxEntries: 10 });
    cache.set('a', 1);
    vi.advanceTimersByTime(1001);
    expect(cache.get('a')).toBeUndefined();
  });

  it('evicts oldest entry when maxEntries is reached', () => {
    const cache = createSchemaCache<number>({ ttlMs: 60_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('refreshes insertion order on overwrite so re-set keys are not evicted first', () => {
    const cache = createSchemaCache<number>({ ttlMs: 60_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 11); // refreshes 'a'
    cache.set('c', 3); // should evict 'b', not 'a'
    expect(cache.get('a')).toBe(11);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('treats ttlMs:0 as disabled (get always undefined, set is a no-op)', () => {
    const cache = createSchemaCache<number>({ ttlMs: 0, maxEntries: 10 });
    cache.set('a', 1);
    expect(cache.get('a')).toBeUndefined();
  });

  it('clear() removes all entries', () => {
    const cache = createSchemaCache<number>({ ttlMs: 1000, maxEntries: 10 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `yarn test src/servicenow/schema-cache.test.ts`
Expected: FAIL with `Cannot find module './schema-cache.js'` (or equivalent).

- [ ] **Step 4: Implement the module**

Create `src/servicenow/schema-cache.ts`:

```ts
export interface SchemaCacheOptions {
  ttlMs: number;
  maxEntries: number;
}

export interface SchemaCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  clear(): void;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export function createSchemaCache<T>(opts: SchemaCacheOptions): SchemaCache<T> {
  const store = new Map<string, Entry<T>>();
  const disabled = opts.ttlMs <= 0;

  return {
    get(key) {
      if (disabled) return undefined;
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() >= entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      if (disabled) return;
      if (store.has(key)) store.delete(key);
      store.set(key, { value, expiresAt: Date.now() + opts.ttlMs });
      while (store.size > opts.maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    clear() {
      store.clear();
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test src/servicenow/schema-cache.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/servicenow/schema-cache.ts src/servicenow/schema-cache.test.ts
git commit -m "feat(cache): add generic SchemaCache with TTL and LRU eviction"
```

### Task 4: Add cache settings to config (test first)

**Files:**

- Modify: `src/config.ts`
- Modify: `src/config.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/config.test.ts` inside the existing `describe('loadConfig', () => { ... })` block:

```ts
it('defaults SCHEMA_CACHE_TTL_MS to 300000', () => {
  const cfg = loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't' });
  expect(cfg.cache.ttlMs).toBe(300_000);
});

it('defaults SCHEMA_CACHE_MAX_ENTRIES to 256', () => {
  const cfg = loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't' });
  expect(cfg.cache.maxEntries).toBe(256);
});

it('parses SCHEMA_CACHE_TTL_MS=0 as disabled', () => {
  const cfg = loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't', SCHEMA_CACHE_TTL_MS: '0' });
  expect(cfg.cache.ttlMs).toBe(0);
});

it('rejects non-integer SCHEMA_CACHE_TTL_MS', () => {
  expect(() => loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't', SCHEMA_CACHE_TTL_MS: 'abc' })).toThrow(
    /SCHEMA_CACHE_TTL_MS/,
  );
});

it('rejects negative SCHEMA_CACHE_TTL_MS', () => {
  expect(() => loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't', SCHEMA_CACHE_TTL_MS: '-1' })).toThrow(
    /SCHEMA_CACHE_TTL_MS/,
  );
});

it('rejects SCHEMA_CACHE_MAX_ENTRIES below 1', () => {
  expect(() =>
    loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't', SCHEMA_CACHE_MAX_ENTRIES: '0' }),
  ).toThrow(/SCHEMA_CACHE_MAX_ENTRIES/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/config.test.ts`
Expected: 6 new tests FAIL with `cfg.cache is undefined` or `Missing required configuration`.

- [ ] **Step 3: Extend `src/config.ts`**

Replace the contents of `src/config.ts` with:

```ts
import { ConfigError } from './errors.js';

export type AuthConfig =
  | { kind: 'bearer'; token: string }
  | { kind: 'basic'; user: string; password: string };

export interface CacheConfig {
  ttlMs: number;
  maxEntries: number;
}

export interface ServerConfig {
  instanceUrl: string;
  auth: AuthConfig;
  cache: CacheConfig;
}

const REQUIRED_AUTH_HINT = 'either SNOW_OAUTH_TOKEN, or both SNOW_USER and SNOW_PASSWORD';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const missing: string[] = [];

  const rawUrl = env.SNOW_INSTANCE_URL?.trim();
  if (!rawUrl) missing.push('SNOW_INSTANCE_URL');

  const token = env.SNOW_OAUTH_TOKEN?.trim();
  const user = env.SNOW_USER?.trim();
  const password = env.SNOW_PASSWORD;
  let auth: AuthConfig | undefined;
  if (token) {
    auth = { kind: 'bearer', token };
  } else if (user && password) {
    auth = { kind: 'basic', user, password };
  } else {
    missing.push(`SNOW_OAUTH_TOKEN`, `SNOW_USER`, `SNOW_PASSWORD (${REQUIRED_AUTH_HINT})`);
  }

  if (missing.length > 0 || !rawUrl || !auth) {
    throw new ConfigError(`Missing required configuration: ${missing.join(', ')}`);
  }

  if (!rawUrl.startsWith('https://')) {
    throw new ConfigError(`SNOW_INSTANCE_URL must use https:// (got: ${rawUrl})`);
  }

  const instanceUrl = rawUrl.replace(/\/+$/, '');
  try {
    new URL(instanceUrl);
  } catch {
    throw new ConfigError(`SNOW_INSTANCE_URL is not a valid URL: ${rawUrl}`);
  }

  const cache: CacheConfig = {
    ttlMs: parseIntEnv(env, 'SCHEMA_CACHE_TTL_MS', 300_000, { min: 0 }),
    maxEntries: parseIntEnv(env, 'SCHEMA_CACHE_MAX_ENTRIES', 256, { min: 1 }),
  };

  return { instanceUrl, auth, cache };
}

function parseIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  bounds: { min: number },
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return defaultValue;
  if (!/^-?\d+$/.test(raw)) {
    throw new ConfigError(`${name} must be an integer (got: ${raw})`);
  }
  const n = Number(raw);
  if (n < bounds.min) {
    throw new ConfigError(`${name} must be >= ${bounds.min} (got: ${n})`);
  }
  return n;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test src/config.test.ts`
Expected: PASS, including 6 new tests and all existing ones.

- [ ] **Step 5: Run full suite to catch other breakage**

Run: `yarn typecheck && yarn test`
Expected: all green. (`ServerConfig` now has a required `cache` field — if any test constructs `ServerConfig` directly without `cache`, it will need updating.)

- [ ] **Step 6: Fix any callers if typecheck breaks**

If `yarn typecheck` flags `src/http/client.test.ts` or similar for missing `cache` field, add `cache: { ttlMs: 0, maxEntries: 0 }` to the test fixtures (cache is irrelevant to those tests). Re-run `yarn typecheck && yarn test` until green.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/config.test.ts src/http/client.test.ts
git commit -m "feat(config): add SCHEMA_CACHE_TTL_MS and SCHEMA_CACHE_MAX_ENTRIES"
```

(Only stage `src/http/client.test.ts` if Step 6 modified it.)

### Task 5: Wire cache into `describe_table` (test first)

**Files:**

- Modify: `src/mcp/tools/describe-table.ts`
- Modify: `src/mcp/tools/describe-table.test.ts`

- [ ] **Step 1: Read the existing describe-table test to learn the fake-client pattern**

Run: `cat src/mcp/tools/describe-table.test.ts`
Note how `client.table.query` is faked.

- [ ] **Step 2: Add a failing test**

Append to `src/mcp/tools/describe-table.test.ts` (preserve existing imports; if `createSchemaCache` is not yet imported, add it):

```ts
import { createSchemaCache } from '../../servicenow/schema-cache.js';

describe('createDescribeTableTool with cache', () => {
  it('returns the cached result on second invocation without calling client.table.query', async () => {
    const queries: { table: string }[] = [];
    const client = {
      table: {
        async query(table: string) {
          queries.push({ table });
          if (table === 'sys_db_object') {
            return { records: [{ name: 'incident', label: 'Incident', super_class: null }] };
          }
          if (table === 'sys_dictionary') {
            return {
              records: [
                {
                  element: 'number',
                  column_label: 'Number',
                  internal_type: { value: 'string' },
                  mandatory: 'false',
                  read_only: 'true',
                },
              ],
            };
          }
          return { records: [] };
        },
      },
    } as unknown as import('../../servicenow/client.js').ServiceNowClient;
    const cache = createSchemaCache<unknown>({ ttlMs: 60_000, maxEntries: 10 });
    const tool = createDescribeTableTool(client, cache);

    const first = await tool.handler({ name: 'incident' });
    const second = await tool.handler({ name: 'incident' });

    expect(queries).toHaveLength(2); // first call hits sys_db_object + sys_dictionary
    expect(second).toEqual(first);
  });

  it('hits the client again after the cache expires', async () => {
    const queries: { table: string }[] = [];
    const client = {
      table: {
        async query(table: string) {
          queries.push({ table });
          if (table === 'sys_db_object') {
            return { records: [{ name: 'incident', label: 'Incident', super_class: null }] };
          }
          return { records: [] };
        },
      },
    } as unknown as import('../../servicenow/client.js').ServiceNowClient;
    const cache = createSchemaCache<unknown>({ ttlMs: 0, maxEntries: 10 }); // disabled
    const tool = createDescribeTableTool(client, cache);

    await tool.handler({ name: 'incident' });
    await tool.handler({ name: 'incident' });

    expect(queries.length).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `yarn test src/mcp/tools/describe-table.test.ts`
Expected: FAIL — `createDescribeTableTool` accepts only one argument.

- [ ] **Step 4: Update `src/mcp/tools/describe-table.ts`**

Add the cache parameter and a cache check. Replace the file with:

```ts
import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
import type { SchemaCache } from '../../servicenow/schema-cache.js';
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
  cache: SchemaCache<unknown>,
): DescribeTableTool {
  return {
    name: 'describe_table',
    description:
      'Describe a ServiceNow table: label, parent table, and field definitions (from sys_dictionary).',
    inputShape: describeTableInput,
    handler: (input) =>
      runTool(async () => {
        const cached = cache.get(input.name);
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
        cache.set(input.name, out);
        return out;
      }),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test src/mcp/tools/describe-table.test.ts`
Expected: PASS — new tests and any existing ones (existing tests may need a cache passed; see Step 6).

- [ ] **Step 6: Fix existing describe-table tests**

If existing tests in `describe-table.test.ts` call `createDescribeTableTool(client)`, update them to pass a cache:

```ts
const cache = createSchemaCache<unknown>({ ttlMs: 0, maxEntries: 0 }); // disabled
const tool = createDescribeTableTool(client, cache);
```

Re-run `yarn test src/mcp/tools/describe-table.test.ts` until green.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/describe-table.ts src/mcp/tools/describe-table.test.ts
git commit -m "feat(describe_table): cache results via SchemaCache"
```

### Task 6: Wire cache into `list_tables` (test first)

**Files:**

- Modify: `src/mcp/tools/list-tables.ts`
- Modify: `src/mcp/tools/list-tables.test.ts`

- [ ] **Step 1: Add a failing test**

Append to `src/mcp/tools/list-tables.test.ts`:

```ts
import { createSchemaCache } from '../../servicenow/schema-cache.js';

describe('createListTablesTool with cache', () => {
  it('caches the full table list and applies filter on the cached result', async () => {
    let queryCount = 0;
    const client = {
      table: {
        async query() {
          queryCount += 1;
          return {
            records: [
              { name: 'incident', label: 'Incident', super_class: 'task', sys_id: 'a' },
              { name: 'change_request', label: 'Change Request', super_class: 'task', sys_id: 'b' },
            ],
          };
        },
      },
    } as unknown as import('../../servicenow/client.js').ServiceNowClient;
    const cache = createSchemaCache<unknown>({ ttlMs: 60_000, maxEntries: 10 });
    const tool = createListTablesTool(client, cache);

    await tool.handler({});
    await tool.handler({ filter: 'incident' });

    expect(queryCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/mcp/tools/list-tables.test.ts`
Expected: FAIL — `createListTablesTool` accepts only one argument.

- [ ] **Step 3: Update `src/mcp/tools/list-tables.ts`**

Replace with:

```ts
import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
import type { SchemaCache } from '../../servicenow/schema-cache.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const listTablesInput = {
  filter: z
    .string()
    .optional()
    .describe('Case-insensitive substring matched against table name and label.'),
};

interface CachedRow {
  name: string;
  label: string;
  super_class?: string;
}

const ALL_KEY = '__all__';

export interface ListTablesTool {
  name: 'list_tables';
  description: string;
  inputShape: typeof listTablesInput;
  handler(input: { filter?: string }): Promise<McpResult>;
}

export function createListTablesTool(
  client: ServiceNowClient,
  cache: SchemaCache<CachedRow[]>,
): ListTablesTool {
  return {
    name: 'list_tables',
    description:
      'List ServiceNow tables visible to the authenticated user. Use the optional `filter` arg to narrow by name or label.',
    inputShape: listTablesInput,
    handler: (input) =>
      runTool(async () => {
        let rows = cache.get(ALL_KEY);
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
          cache.set(ALL_KEY, rows);
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

- [ ] **Step 4: Update existing list-tables tests if needed**

If existing tests in `list-tables.test.ts` call `createListTablesTool(client)`, update them to pass a cache:

```ts
const cache = createSchemaCache<{ name: string; label: string; super_class?: string }[]>({
  ttlMs: 0,
  maxEntries: 0,
});
const tool = createListTablesTool(client, cache);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test src/mcp/tools/list-tables.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/list-tables.ts src/mcp/tools/list-tables.test.ts
git commit -m "feat(list_tables): cache table list via SchemaCache"
```

### Task 7: Wire caches into `createMcpServer`

**Files:**

- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/server.test.ts`
- Modify: `src/main.ts`
- Modify: `src/main.test.ts`

- [ ] **Step 1: Update `createMcpServer` to accept and inject caches**

Replace `src/mcp/server.ts` with:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceNowClient } from '../servicenow/client.js';
import type { CacheConfig } from '../config.js';
import { createSchemaCache } from '../servicenow/schema-cache.js';
import { createListTablesTool } from './tools/list-tables.js';
import { createDescribeTableTool } from './tools/describe-table.js';
import { createQueryTableTool } from './tools/query-table.js';
import { createGetRecordTool } from './tools/get-record.js';
import { createGetAttachmentTool } from './tools/get-attachment.js';
import { createAggregateTool } from './tools/aggregate.js';
import { createRunSavedReportTool } from './tools/run-saved-report.js';
import { createGetUserContextTool } from './tools/get-user-context.js';
import { createTablesResource } from './resources/tables.js';

export function createMcpServer(client: ServiceNowClient, cacheConfig: CacheConfig): McpServer {
  const server = new McpServer({ name: 'snow-mcp', version: '1.0.0' });
  const describeCache = createSchemaCache<unknown>(cacheConfig);
  const listCache =
    createSchemaCache<{ name: string; label: string; super_class?: string }[]>(cacheConfig);

  for (const tool of [
    createListTablesTool(client, listCache),
    createDescribeTableTool(client, describeCache),
    createQueryTableTool(client),
    createGetRecordTool(client),
    createGetAttachmentTool(client),
    createAggregateTool(client),
    createRunSavedReportTool(client),
    createGetUserContextTool(client),
  ]) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputShape },
      (async (args: Record<string, unknown>) =>
        (await tool.handler(args as never)) as unknown as CallToolResult) as never,
    );
  }

  const tables = createTablesResource(client);
  server.registerResource(
    tables.name,
    tables.uri,
    { description: tables.description, mimeType: tables.mimeType },
    (async () => (await tables.read()) as unknown as ReadResourceResult) as never,
  );

  return server;
}
```

- [ ] **Step 2: Update `src/main.ts`**

Replace with:

```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from './config.js';
import { createServiceNowClient } from './servicenow/client.js';
import { createMcpServer } from './mcp/server.js';

export function buildServer(env: NodeJS.ProcessEnv = process.env): McpServer {
  const config = loadConfig(env);
  const client = createServiceNowClient(config);
  return createMcpServer(client, config.cache);
}

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
```

- [ ] **Step 3: Update `src/mcp/server.test.ts`**

Find every call to `createMcpServer(client)` and change it to `createMcpServer(client, { ttlMs: 0, maxEntries: 1 })`. (Cache disabled to keep existing assertions stable.)

- [ ] **Step 4: Run the affected tests**

Run: `yarn test src/main.test.ts src/mcp/server.test.ts src/mcp/tools/describe-table.test.ts src/mcp/tools/list-tables.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `yarn typecheck && yarn lint && yarn test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts src/main.ts src/mcp/server.test.ts
git commit -m "feat(mcp): inject schema caches from config into server"
```

### Task 8: Add `.env.example` and README "Schema cache" section

**Files:**

- Create: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Create `.env.example`**

```dotenv
# ServiceNow instance (required, https only)
SNOW_INSTANCE_URL=https://example.service-now.com

# Auth — pick one path:
# 1) Basic auth (default in v1.0)
SNOW_USER=
SNOW_PASSWORD=
# 2) Static OAuth bearer token
# SNOW_OAUTH_TOKEN=

# Schema cache (optional; defaults shown)
# SCHEMA_CACHE_TTL_MS=300000
# SCHEMA_CACHE_MAX_ENTRIES=256
```

- [ ] **Step 2: Add a Schema Cache section to `README.md`**

Locate the existing "Configuration" (or equivalent) section in README.md. Below it, add:

```markdown
### Schema cache

`describe_table` and `list_tables` cache results in memory to avoid repeated `sys_dictionary` and `sys_db_object` lookups. Defaults:

| Variable                   | Default  | Notes                                       |
| -------------------------- | -------- | ------------------------------------------- |
| `SCHEMA_CACHE_TTL_MS`      | `300000` | 5 minutes. Set to `0` to disable the cache. |
| `SCHEMA_CACHE_MAX_ENTRIES` | `256`    | Hard cap on cached entries per tool.        |

After a schema customization in ServiceNow, restart the server or wait for the TTL to expire.
```

- [ ] **Step 3: Verify the suite still passes**

Run: `yarn test`
Expected: 74+ tests, all passing.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "docs(cache): document SCHEMA_CACHE_* env vars and add .env.example"
```

### Task 9: Merge `feat/schema-cache` into `main`

- [ ] **Step 1: Final verification**

Run: `yarn typecheck && yarn lint && yarn test`
Expected: all green.

- [ ] **Step 2: Merge**

```bash
git checkout main
git merge --no-ff feat/schema-cache -m "Merge feat/schema-cache: in-memory TTL cache for describe_table and list_tables"
git status
```

Expected: `nothing to commit, working tree clean`.

---

## Branch 3: `feat/oauth-and-http`

### Task 10: Define the `AuthProvider` interface (test first)

**Files:**

- Create: `src/servicenow/auth/auth-provider.ts`
- Create: `src/servicenow/auth/auth-provider.test.ts`

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/oauth-and-http
```

- [ ] **Step 2: Write a failing test that the interface contract exists**

Create `src/servicenow/auth/auth-provider.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { AuthProvider } from './auth-provider.js';

describe('AuthProvider', () => {
  it('a concrete implementation satisfies the interface', async () => {
    const provider: AuthProvider = {
      async getAuthHeader() {
        return 'Basic abc';
      },
      async onUnauthorized() {
        // no-op
      },
    };
    expect(await provider.getAuthHeader()).toBe('Basic abc');
    await expect(provider.onUnauthorized()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `yarn test src/servicenow/auth/auth-provider.test.ts`
Expected: FAIL — `Cannot find module './auth-provider.js'`.

- [ ] **Step 4: Create the interface**

Create `src/servicenow/auth/auth-provider.ts`:

```ts
export interface AuthProvider {
  getAuthHeader(): Promise<string>;
  onUnauthorized(): Promise<void>;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `yarn test src/servicenow/auth/auth-provider.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/servicenow/auth/auth-provider.ts src/servicenow/auth/auth-provider.test.ts
git commit -m "feat(auth): introduce AuthProvider interface"
```

### Task 11: Implement `BasicAuthProvider` (test first)

**Files:**

- Create: `src/servicenow/auth/basic-auth-provider.ts`
- Create: `src/servicenow/auth/basic-auth-provider.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/servicenow/auth/basic-auth-provider.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createBasicAuthProvider } from './basic-auth-provider.js';

describe('createBasicAuthProvider', () => {
  it('returns the Basic <base64(user:password)> header', async () => {
    const provider = createBasicAuthProvider({ user: 'u', password: 'p' });
    expect(await provider.getAuthHeader()).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('onUnauthorized resolves without throwing', async () => {
    const provider = createBasicAuthProvider({ user: 'u', password: 'p' });
    await expect(provider.onUnauthorized()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/servicenow/auth/basic-auth-provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the provider**

Create `src/servicenow/auth/basic-auth-provider.ts`:

```ts
import type { AuthProvider } from './auth-provider.js';

export interface BasicAuthOptions {
  user: string;
  password: string;
}

export function createBasicAuthProvider(opts: BasicAuthOptions): AuthProvider {
  const header = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString('base64')}`;
  return {
    async getAuthHeader() {
      return header;
    },
    async onUnauthorized() {
      // basic auth doesn't refresh
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test src/servicenow/auth/basic-auth-provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/servicenow/auth/basic-auth-provider.ts src/servicenow/auth/basic-auth-provider.test.ts
git commit -m "feat(auth): add BasicAuthProvider"
```

### Task 12: Implement `BearerStaticAuthProvider` (test first)

**Files:**

- Create: `src/servicenow/auth/bearer-static-auth-provider.ts`
- Create: `src/servicenow/auth/bearer-static-auth-provider.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/servicenow/auth/bearer-static-auth-provider.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createBearerStaticAuthProvider } from './bearer-static-auth-provider.js';

describe('createBearerStaticAuthProvider', () => {
  it('returns Bearer <token>', async () => {
    const provider = createBearerStaticAuthProvider({ token: 'abc' });
    expect(await provider.getAuthHeader()).toBe('Bearer abc');
  });

  it('onUnauthorized resolves without throwing', async () => {
    const provider = createBearerStaticAuthProvider({ token: 'abc' });
    await expect(provider.onUnauthorized()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/servicenow/auth/bearer-static-auth-provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the provider**

Create `src/servicenow/auth/bearer-static-auth-provider.ts`:

```ts
import type { AuthProvider } from './auth-provider.js';

export interface BearerStaticOptions {
  token: string;
}

export function createBearerStaticAuthProvider(opts: BearerStaticOptions): AuthProvider {
  const header = `Bearer ${opts.token}`;
  return {
    async getAuthHeader() {
      return header;
    },
    async onUnauthorized() {
      // static token has no refresh
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test src/servicenow/auth/bearer-static-auth-provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/servicenow/auth/bearer-static-auth-provider.ts src/servicenow/auth/bearer-static-auth-provider.test.ts
git commit -m "feat(auth): add BearerStaticAuthProvider for SNOW_OAUTH_TOKEN"
```

### Task 13: Implement `OAuthClientCredentialsProvider` (test first)

**Files:**

- Create: `src/servicenow/auth/oauth-client-credentials-provider.ts`
- Create: `src/servicenow/auth/oauth-client-credentials-provider.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/servicenow/auth/oauth-client-credentials-provider.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createOAuthClientCredentialsProvider } from './oauth-client-credentials-provider.js';

const BASE_OPTS = {
  instanceUrl: 'https://example.service-now.com',
  clientId: 'id',
  clientSecret: 'secret',
};

function fetchReturning(responses: Response[]): {
  fn: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let idx = 0;
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const res = responses[idx];
    idx = Math.min(idx + 1, responses.length - 1);
    return res as Response;
  }) as typeof fetch;
  return { fn, calls };
}

function tokenResponse(token: string, expiresIn: number): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createOAuthClientCredentialsProvider', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') }));
  afterEach(() => vi.useRealTimers());

  it('fetches a token on first call and returns Bearer <token>', async () => {
    const { fn, calls } = fetchReturning([tokenResponse('tok1', 3600)]);
    const provider = createOAuthClientCredentialsProvider(BASE_OPTS, fn);
    expect(await provider.getAuthHeader()).toBe('Bearer tok1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://example.service-now.com/oauth_token.do');
    expect(calls[0]?.init?.method).toBe('POST');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const body = String(calls[0]?.init?.body ?? '');
    expect(body).toContain('grant_type=client_credentials');
    expect(body).toContain('client_id=id');
    expect(body).toContain('client_secret=secret');
  });

  it('reuses the cached token on subsequent calls within ttl', async () => {
    const { fn, calls } = fetchReturning([tokenResponse('tok1', 3600)]);
    const provider = createOAuthClientCredentialsProvider(BASE_OPTS, fn);
    await provider.getAuthHeader();
    await provider.getAuthHeader();
    expect(calls).toHaveLength(1);
  });

  it('refreshes the token after expiry (expires_in - 30s)', async () => {
    const { fn, calls } = fetchReturning([tokenResponse('tok1', 60), tokenResponse('tok2', 60)]);
    const provider = createOAuthClientCredentialsProvider(BASE_OPTS, fn);
    expect(await provider.getAuthHeader()).toBe('Bearer tok1');
    vi.advanceTimersByTime(31_000); // past (60-30)*1000
    expect(await provider.getAuthHeader()).toBe('Bearer tok2');
    expect(calls).toHaveLength(2);
  });

  it('onUnauthorized invalidates the cached token, forcing a refresh', async () => {
    const { fn, calls } = fetchReturning([
      tokenResponse('tok1', 3600),
      tokenResponse('tok2', 3600),
    ]);
    const provider = createOAuthClientCredentialsProvider(BASE_OPTS, fn);
    expect(await provider.getAuthHeader()).toBe('Bearer tok1');
    await provider.onUnauthorized();
    expect(await provider.getAuthHeader()).toBe('Bearer tok2');
    expect(calls).toHaveLength(2);
  });

  it('throws ServiceNowAuthError when the token endpoint returns 4xx', async () => {
    const { fn } = fetchReturning([
      new Response(JSON.stringify({ error: 'invalid_client' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const provider = createOAuthClientCredentialsProvider(BASE_OPTS, fn);
    await expect(provider.getAuthHeader()).rejects.toMatchObject({
      name: 'ServiceNowAuthError',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/servicenow/auth/oauth-client-credentials-provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the provider**

Create `src/servicenow/auth/oauth-client-credentials-provider.ts`:

```ts
import type { AuthProvider } from './auth-provider.js';
import { ServiceNowAuthError, ServiceNowServerError } from '../../errors.js';

export interface OAuthClientCredentialsOptions {
  instanceUrl: string;
  clientId: string;
  clientSecret: string;
}

interface TokenState {
  token: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

const REFRESH_LEEWAY_MS = 30_000;

export function createOAuthClientCredentialsProvider(
  opts: OAuthClientCredentialsOptions,
  fetchImpl: typeof fetch = fetch,
): AuthProvider {
  let state: TokenState | undefined;

  async function fetchToken(): Promise<TokenState> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    });
    const res = await fetchImpl(`${opts.instanceUrl}/oauth_token.do`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (res.status === 401 || res.status === 403) {
      throw new ServiceNowAuthError(
        res.status,
        await safeJson(res),
        'OAuth token request rejected (check SNOW_OAUTH_CLIENT_ID / SNOW_OAUTH_CLIENT_SECRET)',
      );
    }
    if (!res.ok) {
      throw new ServiceNowServerError(
        res.status,
        await safeJson(res),
        `OAuth token request failed with status ${res.status}`,
      );
    }
    const data = (await res.json()) as TokenResponse;
    if (!data.access_token || typeof data.expires_in !== 'number') {
      throw new ServiceNowServerError(
        res.status,
        data,
        'OAuth token response missing access_token or expires_in',
      );
    }
    return {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(0, data.expires_in * 1000 - REFRESH_LEEWAY_MS),
    };
  }

  return {
    async getAuthHeader() {
      if (!state || Date.now() >= state.expiresAt) {
        state = await fetchToken();
      }
      return `Bearer ${state.token}`;
    },
    async onUnauthorized() {
      state = undefined;
    },
  };
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test src/servicenow/auth/oauth-client-credentials-provider.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/servicenow/auth/oauth-client-credentials-provider.ts src/servicenow/auth/oauth-client-credentials-provider.test.ts
git commit -m "feat(auth): add OAuthClientCredentialsProvider with token caching"
```

### Task 14: Create the auth provider factory

**Files:**

- Create: `src/servicenow/auth/index.ts`

- [ ] **Step 1: Add a failing test**

Create `src/servicenow/auth/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createAuthProvider } from './index.js';

describe('createAuthProvider', () => {
  it('builds a basic provider from { kind: "basic" }', async () => {
    const p = createAuthProvider(
      { kind: 'basic', user: 'u', password: 'p' },
      'https://example.service-now.com',
    );
    expect(await p.getAuthHeader()).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('builds a bearer-static provider from { kind: "bearer" }', async () => {
    const p = createAuthProvider(
      { kind: 'bearer', token: 'abc' },
      'https://example.service-now.com',
    );
    expect(await p.getAuthHeader()).toBe('Bearer abc');
  });

  it('builds an OAuth client_credentials provider from { kind: "oauth_client_credentials" }', () => {
    const p = createAuthProvider(
      { kind: 'oauth_client_credentials', clientId: 'id', clientSecret: 'sec' },
      'https://example.service-now.com',
    );
    expect(typeof p.getAuthHeader).toBe('function');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/servicenow/auth/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the factory**

Create `src/servicenow/auth/index.ts`:

```ts
import type { AuthConfig } from '../../config.js';
import type { AuthProvider } from './auth-provider.js';
import { createBasicAuthProvider } from './basic-auth-provider.js';
import { createBearerStaticAuthProvider } from './bearer-static-auth-provider.js';
import { createOAuthClientCredentialsProvider } from './oauth-client-credentials-provider.js';

export type { AuthProvider } from './auth-provider.js';

export function createAuthProvider(
  auth: AuthConfig,
  instanceUrl: string,
  fetchImpl: typeof fetch = fetch,
): AuthProvider {
  switch (auth.kind) {
    case 'basic':
      return createBasicAuthProvider({ user: auth.user, password: auth.password });
    case 'bearer':
      return createBearerStaticAuthProvider({ token: auth.token });
    case 'oauth_client_credentials':
      return createOAuthClientCredentialsProvider(
        { instanceUrl, clientId: auth.clientId, clientSecret: auth.clientSecret },
        fetchImpl,
      );
  }
}
```

Note: this references `AuthConfig` with a third variant `oauth_client_credentials` which Task 15 will add. The factory will fail typecheck until then — that's expected; the next task wires it up.

- [ ] **Step 4: Stop here without running the test (typecheck will fail)**

Do NOT run `yarn typecheck` yet. Move to Task 15.

- [ ] **Step 5: Stage the new files (commit happens with Task 15)**

```bash
git add src/servicenow/auth/index.ts src/servicenow/auth/index.test.ts
```

### Task 15: Extend config with OAuth client_credentials (test first)

**Files:**

- Modify: `src/config.ts`
- Modify: `src/config.test.ts`

- [ ] **Step 1: Add failing tests**

Append inside the existing `describe('loadConfig', () => { ... })` block in `src/config.test.ts`:

```ts
it('selects oauth_client_credentials when SNOW_OAUTH_CLIENT_ID and SNOW_OAUTH_CLIENT_SECRET are set', () => {
  const cfg = loadConfig({
    ...BASE,
    SNOW_OAUTH_CLIENT_ID: 'id',
    SNOW_OAUTH_CLIENT_SECRET: 'sec',
  });
  expect(cfg.auth).toEqual({
    kind: 'oauth_client_credentials',
    clientId: 'id',
    clientSecret: 'sec',
  });
});

it('prefers oauth_client_credentials over bearer token when both are set', () => {
  const cfg = loadConfig({
    ...BASE,
    SNOW_OAUTH_CLIENT_ID: 'id',
    SNOW_OAUTH_CLIENT_SECRET: 'sec',
    SNOW_OAUTH_TOKEN: 'abc',
    SNOW_USER: 'u',
    SNOW_PASSWORD: 'p',
  });
  expect(cfg.auth.kind).toBe('oauth_client_credentials');
});

it('rejects partial OAuth client_credentials (only CLIENT_ID)', () => {
  expect(() => loadConfig({ ...BASE, SNOW_OAUTH_CLIENT_ID: 'id' })).toThrow(
    /SNOW_OAUTH_CLIENT_SECRET/,
  );
});

it('rejects partial OAuth client_credentials (only CLIENT_SECRET)', () => {
  expect(() => loadConfig({ ...BASE, SNOW_OAUTH_CLIENT_SECRET: 'sec' })).toThrow(
    /SNOW_OAUTH_CLIENT_ID/,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/config.test.ts`
Expected: 4 new tests FAIL.

- [ ] **Step 3: Extend `src/config.ts`**

Replace the `AuthConfig` type and the auth-selection block. Final file:

```ts
import { ConfigError } from './errors.js';

export type AuthConfig =
  | { kind: 'bearer'; token: string }
  | { kind: 'basic'; user: string; password: string }
  | { kind: 'oauth_client_credentials'; clientId: string; clientSecret: string };

export interface CacheConfig {
  ttlMs: number;
  maxEntries: number;
}

export interface ServerConfig {
  instanceUrl: string;
  auth: AuthConfig;
  cache: CacheConfig;
}

const REQUIRED_AUTH_HINT =
  'SNOW_OAUTH_CLIENT_ID+SNOW_OAUTH_CLIENT_SECRET, SNOW_OAUTH_TOKEN, or SNOW_USER+SNOW_PASSWORD';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const missing: string[] = [];

  const rawUrl = env.SNOW_INSTANCE_URL?.trim();
  if (!rawUrl) missing.push('SNOW_INSTANCE_URL');

  const clientId = env.SNOW_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.SNOW_OAUTH_CLIENT_SECRET?.trim();
  const token = env.SNOW_OAUTH_TOKEN?.trim();
  const user = env.SNOW_USER?.trim();
  const password = env.SNOW_PASSWORD;

  if ((clientId && !clientSecret) || (!clientId && clientSecret)) {
    throw new ConfigError('SNOW_OAUTH_CLIENT_ID and SNOW_OAUTH_CLIENT_SECRET must be set together');
  }

  let auth: AuthConfig | undefined;
  if (clientId && clientSecret) {
    auth = { kind: 'oauth_client_credentials', clientId, clientSecret };
  } else if (token) {
    auth = { kind: 'bearer', token };
  } else if (user && password) {
    auth = { kind: 'basic', user, password };
  } else {
    missing.push(`auth (${REQUIRED_AUTH_HINT})`);
  }

  if (missing.length > 0 || !rawUrl || !auth) {
    throw new ConfigError(`Missing required configuration: ${missing.join(', ')}`);
  }

  if (!rawUrl.startsWith('https://')) {
    throw new ConfigError(`SNOW_INSTANCE_URL must use https:// (got: ${rawUrl})`);
  }

  const instanceUrl = rawUrl.replace(/\/+$/, '');
  try {
    new URL(instanceUrl);
  } catch {
    throw new ConfigError(`SNOW_INSTANCE_URL is not a valid URL: ${rawUrl}`);
  }

  const cache: CacheConfig = {
    ttlMs: parseIntEnv(env, 'SCHEMA_CACHE_TTL_MS', 300_000, { min: 0 }),
    maxEntries: parseIntEnv(env, 'SCHEMA_CACHE_MAX_ENTRIES', 256, { min: 1 }),
  };

  return { instanceUrl, auth, cache };
}

function parseIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  bounds: { min: number },
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return defaultValue;
  if (!/^-?\d+$/.test(raw)) {
    throw new ConfigError(`${name} must be an integer (got: ${raw})`);
  }
  const n = Number(raw);
  if (n < bounds.min) {
    throw new ConfigError(`${name} must be >= ${bounds.min} (got: ${n})`);
  }
  return n;
}
```

- [ ] **Step 4: Update the existing "names every missing var" test**

The original test asserts the error message contains `SNOW_OAUTH_TOKEN`, `SNOW_USER`, `SNOW_PASSWORD`. With the new hint string, it should also contain `SNOW_OAUTH_CLIENT_ID`. Adjust the assertion:

In `src/config.test.ts` find:

```ts
expect((err as Error).message).toContain('SNOW_OAUTH_TOKEN');
expect((err as Error).message).toContain('SNOW_USER');
expect((err as Error).message).toContain('SNOW_PASSWORD');
```

Replace with:

```ts
expect((err as Error).message).toContain('SNOW_OAUTH_CLIENT_ID');
expect((err as Error).message).toContain('SNOW_OAUTH_CLIENT_SECRET');
expect((err as Error).message).toContain('SNOW_OAUTH_TOKEN');
expect((err as Error).message).toContain('SNOW_USER');
expect((err as Error).message).toContain('SNOW_PASSWORD');
```

- [ ] **Step 5: Run tests**

Run: `yarn test src/config.test.ts src/servicenow/auth/index.test.ts`
Expected: PASS.

- [ ] **Step 6: Full typecheck**

Run: `yarn typecheck`
Expected: no errors. The `createAuthProvider` factory from Task 14 now typechecks.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/config.test.ts src/servicenow/auth/index.ts src/servicenow/auth/index.test.ts
git commit -m "feat(config,auth): support OAuth client_credentials via SNOW_OAUTH_CLIENT_ID/SECRET"
```

### Task 16: Make `createHttpClient` use `AuthProvider` and retry once on 401 (test first)

**Files:**

- Modify: `src/http/client.ts`
- Modify: `src/http/client.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/http/client.test.ts`:

```ts
function fakeFetchSequence(responses: Response[]): {
  fn: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let idx = 0;
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const res = responses[Math.min(idx, responses.length - 1)];
    idx += 1;
    return res as Response;
  }) as typeof fetch;
  return { fn, calls };
}

describe('createHttpClient — 401 retry', () => {
  it('retries the request exactly once after a 401 and surfaces the second response', async () => {
    const { fn, calls } = fakeFetchSequence([
      new Response('{}', { status: 401 }),
      new Response('{"result":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const client = createHttpClient(cfgBasic, fn);
    const res = await client.request('/api/now/table/incident');
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('does not retry more than once on persistent 401', async () => {
    const { fn, calls } = fakeFetchSequence([
      new Response('{}', { status: 401 }),
      new Response('{}', { status: 401 }),
      new Response('{}', { status: 401 }),
    ]);
    const client = createHttpClient(cfgBasic, fn);
    const res = await client.request('/api/now/table/incident');
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/http/client.test.ts`
Expected: 2 new tests FAIL (current code does no 401 retry).

- [ ] **Step 3: Refactor `src/http/client.ts`**

Replace contents with:

```ts
import { ReadOnlyViolationError } from '../errors.js';
import type { ServerConfig } from '../config.js';
import { createAuthProvider, type AuthProvider } from '../servicenow/auth/index.js';

export interface RequestOptions {
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface HttpClient {
  request(path: string, opts?: RequestOptions): Promise<Response>;
  requestRaw(method: 'GET', path: string, opts?: RequestOptions): Promise<Response>;
}

const ALLOWED_METHOD = 'GET';

export function createHttpClient(
  config: ServerConfig,
  fetchImpl: typeof fetch = fetch,
  authProvider: AuthProvider = createAuthProvider(config.auth, config.instanceUrl, fetchImpl),
): HttpClient {
  async function requestRaw(
    method: 'GET',
    path: string,
    opts: RequestOptions = {},
  ): Promise<Response> {
    if ((method as string) !== ALLOWED_METHOD) {
      throw new ReadOnlyViolationError(method);
    }
    const url = new URL(path.replace(/^\/+/, '/'), config.instanceUrl + '/');
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }

    const send = async () => {
      const headers = new Headers(opts.headers);
      headers.set('Authorization', await authProvider.getAuthHeader());
      headers.set('Accept', 'application/json');
      return fetchImpl(url.toString(), { method, headers, signal: opts.signal });
    };

    const first = await send();
    if (first.status !== 401) return first;
    await authProvider.onUnauthorized();
    return send();
  }

  return {
    request: (path, opts) => requestRaw('GET', path, opts),
    requestRaw,
  };
}

const REDACTED = '[REDACTED]';
const SECRET_KEY_PATTERNS = [
  /^authorization$/i,
  /^snow_password$/i,
  /^snow_oauth_token$/i,
  /^snow_oauth_client_secret$/i,
  /password/i,
  /token/i,
  /secret/i,
];

export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERNS.some((p) => p.test(k))) {
      out[k] = REDACTED;
    } else {
      out[k] = redact(v, seen);
    }
  }
  return out;
}
```

- [ ] **Step 4: Update the existing test fixtures that lack `cache`**

If `cfgBasic` and `cfgBearer` in `src/http/client.test.ts` were not updated in Task 4 (Step 6), add `cache: { ttlMs: 0, maxEntries: 0 }`:

```ts
const cfgBasic: ServerConfig = {
  instanceUrl: 'https://example.service-now.com',
  auth: { kind: 'basic', user: 'u', password: 'p' },
  cache: { ttlMs: 0, maxEntries: 0 },
};
const cfgBearer: ServerConfig = {
  instanceUrl: 'https://example.service-now.com',
  auth: { kind: 'bearer', token: 'abc' },
  cache: { ttlMs: 0, maxEntries: 0 },
};
```

- [ ] **Step 5: Run tests**

Run: `yarn test src/http/client.test.ts`
Expected: all tests PASS, including the new 401-retry ones.

- [ ] **Step 6: Run the full suite**

Run: `yarn typecheck && yarn lint && yarn test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/http/client.ts src/http/client.test.ts
git commit -m "feat(http): route auth through AuthProvider; retry once on 401"
```

### Task 17: Create the stdio transport module (refactor only)

**Files:**

- Create: `src/mcp/transport/stdio.ts`

- [ ] **Step 1: Extract the stdio transport setup**

Create `src/mcp/transport/stdio.ts`:

```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export async function connectStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 2: Verify the suite still passes**

Run: `yarn typecheck && yarn test`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/transport/stdio.ts
git commit -m "refactor(transport): extract stdio connection into transport/stdio.ts"
```

### Task 18: Add the HTTP (Streamable) transport (test first)

**Files:**

- Create: `src/mcp/transport/http.ts`
- Create: `src/mcp/transport/http.test.ts`

- [ ] **Step 1: Confirm the Streamable HTTP transport export path**

Run: `node -e "import('@modelcontextprotocol/sdk/server/streamableHttp.js').then(m => console.log(Object.keys(m)))"`
Expected output includes `StreamableHTTPServerTransport`. Use this exact import path. If the path differs in the installed SDK version, run `grep -r "StreamableHTTPServerTransport" node_modules/@modelcontextprotocol/sdk/dist --include='*.d.ts' -l | head -5` to find it.

- [ ] **Step 2: Write a failing test**

Create `src/mcp/transport/http.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { connectHttp } from './http.js';

describe('connectHttp', () => {
  it('starts an HTTP server on the requested port and responds to MCP initialize', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const handle = await connectHttp(server, { host: '127.0.0.1', port: 0 }); // 0 = ephemeral
    try {
      const url = `http://127.0.0.1:${handle.port}/mcp`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '0.0.0' },
          },
        }),
      });
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    } finally {
      await handle.close();
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `yarn test src/mcp/transport/http.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `connectHttp`**

Create `src/mcp/transport/http.ts`:

```ts
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface HttpTransportOptions {
  host: string;
  port: number;
}

export interface HttpTransportHandle {
  port: number;
  close(): Promise<void>;
}

export async function connectHttp(
  server: McpServer,
  opts: HttpTransportOptions,
): Promise<HttpTransportHandle> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
    enableJsonResponse: true,
  });
  await server.connect(transport);

  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!req.url || !req.url.startsWith('/mcp')) {
      res.statusCode = 404;
      res.end();
      return;
    }
    void transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, opts.host, resolve);
  });
  const addr = httpServer.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : opts.port;

  return {
    port: boundPort,
    async close() {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      await transport.close();
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `yarn test src/mcp/transport/http.test.ts`
Expected: PASS.

If the test fails due to a different SDK API (e.g., `StreamableHTTPServerTransport` does not have `handleRequest` or `close` in this SDK version), check `node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.d.ts` and adapt the call sites. Do not invent methods.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/transport/http.ts src/mcp/transport/http.test.ts
git commit -m "feat(transport): add Streamable HTTP transport"
```

### Task 19: Add transport selector + config vars (test first)

**Files:**

- Modify: `src/config.ts`
- Modify: `src/config.test.ts`
- Create: `src/mcp/transport/index.ts`

- [ ] **Step 1: Add failing tests**

Append inside `describe('loadConfig', ...)` in `src/config.test.ts`:

```ts
it('defaults transport to stdio on 127.0.0.1:3000', () => {
  const cfg = loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't' });
  expect(cfg.transport).toEqual({ kind: 'stdio', host: '127.0.0.1', port: 3000 });
});

it('parses MCP_TRANSPORT=http with default host and port', () => {
  const cfg = loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't', MCP_TRANSPORT: 'http' });
  expect(cfg.transport).toEqual({ kind: 'http', host: '127.0.0.1', port: 3000 });
});

it('parses MCP_HTTP_PORT and MCP_HTTP_HOST', () => {
  const cfg = loadConfig({
    ...BASE,
    SNOW_OAUTH_TOKEN: 't',
    MCP_TRANSPORT: 'http',
    MCP_HTTP_PORT: '8080',
    MCP_HTTP_HOST: '0.0.0.0',
  });
  expect(cfg.transport).toEqual({ kind: 'http', host: '0.0.0.0', port: 8080 });
});

it('rejects MCP_TRANSPORT values other than stdio or http', () => {
  expect(() => loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't', MCP_TRANSPORT: 'ws' })).toThrow(
    /MCP_TRANSPORT/,
  );
});

it('rejects MCP_HTTP_PORT outside 1..65535', () => {
  expect(() =>
    loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't', MCP_TRANSPORT: 'http', MCP_HTTP_PORT: '0' }),
  ).toThrow(/MCP_HTTP_PORT/);
  expect(() =>
    loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't', MCP_TRANSPORT: 'http', MCP_HTTP_PORT: '70000' }),
  ).toThrow(/MCP_HTTP_PORT/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/config.test.ts`
Expected: 5 new tests FAIL.

- [ ] **Step 3: Add `TransportConfig` to `src/config.ts`**

Within `src/config.ts`, add:

```ts
export type TransportConfig =
  | { kind: 'stdio'; host: string; port: number }
  | { kind: 'http'; host: string; port: number };
```

Add `transport: TransportConfig` to `ServerConfig`. In `loadConfig`, after the `cache` block, add:

```ts
const transportKind = (env.MCP_TRANSPORT?.trim() || 'stdio') as string;
if (transportKind !== 'stdio' && transportKind !== 'http') {
  throw new ConfigError(`MCP_TRANSPORT must be "stdio" or "http" (got: ${transportKind})`);
}
const httpHost = env.MCP_HTTP_HOST?.trim() || '127.0.0.1';
const httpPort = parseIntEnv(env, 'MCP_HTTP_PORT', 3000, { min: 1 });
if (httpPort > 65535) {
  throw new ConfigError(`MCP_HTTP_PORT must be <= 65535 (got: ${httpPort})`);
}
const transport: TransportConfig = { kind: transportKind, host: httpHost, port: httpPort };
```

Add `transport` to the returned object:

```ts
return { instanceUrl, auth, cache, transport };
```

- [ ] **Step 4: Create the transport factory**

Create `src/mcp/transport/index.ts`:

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TransportConfig } from '../../config.js';
import { connectStdio } from './stdio.js';
import { connectHttp, type HttpTransportHandle } from './http.js';

export interface TransportHandle {
  close(): Promise<void>;
}

export async function connectTransport(
  server: McpServer,
  config: TransportConfig,
): Promise<TransportHandle> {
  if (config.kind === 'stdio') {
    await connectStdio(server);
    return { async close() {} };
  }
  const handle: HttpTransportHandle = await connectHttp(server, {
    host: config.host,
    port: config.port,
  });
  return handle;
}
```

- [ ] **Step 5: Run tests**

Run: `yarn test src/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full suite**

Run: `yarn typecheck && yarn test`
Expected: green. If any other test fixture builds a `ServerConfig` literal without `transport`, add `transport: { kind: 'stdio', host: '127.0.0.1', port: 3000 }`.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/config.test.ts src/mcp/transport/index.ts src/http/client.test.ts
git commit -m "feat(config,transport): add MCP_TRANSPORT/MCP_HTTP_HOST/MCP_HTTP_PORT and selector"
```

(Stage `src/http/client.test.ts` only if Step 6 modified its fixtures.)

### Task 20: Switch `main.ts` to the transport factory

**Files:**

- Modify: `src/main.ts`
- Modify: `src/main.test.ts`

- [ ] **Step 1: Update `src/main.ts`**

Replace with:

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig, type ServerConfig } from './config.js';
import { createServiceNowClient } from './servicenow/client.js';
import { createMcpServer } from './mcp/server.js';
import { connectTransport } from './mcp/transport/index.js';

export function buildServer(env: NodeJS.ProcessEnv = process.env): {
  server: McpServer;
  config: ServerConfig;
} {
  const config = loadConfig(env);
  const client = createServiceNowClient(config);
  const server = createMcpServer(client, config.cache);
  return { server, config };
}

async function main(): Promise<void> {
  const { server, config } = buildServer();
  await connectTransport(server, config.transport);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
```

This changes `buildServer`'s return type from `McpServer` to `{ server, config }`. Callers must be updated.

- [ ] **Step 2: Update `src/main.test.ts`**

Replace with:

```ts
import { describe, expect, it } from 'vitest';
import { buildServer } from './main.js';

describe('buildServer', () => {
  it('throws ConfigError when env is empty', () => {
    expect(() => buildServer({})).toThrow(/Missing required configuration/);
  });

  it('returns a connectable McpServer when env is valid', () => {
    const { server } = buildServer({
      SNOW_INSTANCE_URL: 'https://example.service-now.com',
      SNOW_OAUTH_TOKEN: 't',
    });
    expect(server.server).toBeDefined();
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(tools)).toHaveLength(8);
  });

  it('returns a ServerConfig with transport=stdio by default', () => {
    const { config } = buildServer({
      SNOW_INSTANCE_URL: 'https://example.service-now.com',
      SNOW_OAUTH_TOKEN: 't',
    });
    expect(config.transport.kind).toBe('stdio');
  });
});
```

- [ ] **Step 3: Run tests**

Run: `yarn typecheck && yarn test src/main.test.ts`
Expected: green.

- [ ] **Step 4: Run full suite**

Run: `yarn lint && yarn test`
Expected: 74+ tests, all green.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/main.test.ts
git commit -m "feat(main): select transport via config (stdio default, http opt-in)"
```

### Task 21: Update `.env.example` and README

**Files:**

- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Extend `.env.example`**

Replace `.env.example` with:

```dotenv
# ServiceNow instance (required, https only)
SNOW_INSTANCE_URL=https://example.service-now.com

# Auth — pick one path (priority: client_credentials > token > basic):
# 1) Basic auth
SNOW_USER=
SNOW_PASSWORD=
# 2) Static OAuth bearer token
# SNOW_OAUTH_TOKEN=
# 3) OAuth client_credentials (server-to-server)
# SNOW_OAUTH_CLIENT_ID=
# SNOW_OAUTH_CLIENT_SECRET=

# MCP transport (optional)
# MCP_TRANSPORT=stdio        # or "http"
# MCP_HTTP_HOST=127.0.0.1
# MCP_HTTP_PORT=3000

# Schema cache (optional)
# SCHEMA_CACHE_TTL_MS=300000
# SCHEMA_CACHE_MAX_ENTRIES=256
```

- [ ] **Step 2: Add Auth and Transport sections to `README.md`**

Locate the "Configuration" section. Add:

```markdown
### Auth

snow-mcp picks an auth strategy from the env. Priority: client_credentials > static token > basic.

| Vars                                                | Strategy                 |
| --------------------------------------------------- | ------------------------ |
| `SNOW_OAUTH_CLIENT_ID` + `SNOW_OAUTH_CLIENT_SECRET` | OAuth client_credentials |
| `SNOW_OAUTH_TOKEN`                                  | Static bearer token      |
| `SNOW_USER` + `SNOW_PASSWORD`                       | HTTP Basic               |

OAuth client_credentials fetches a token from `${SNOW_INSTANCE_URL}/oauth_token.do`, caches it until 30s before expiry, and refreshes automatically (also on a 401 from the ServiceNow API).

### Transport

| Variable        | Default     | Notes                                |
| --------------- | ----------- | ------------------------------------ |
| `MCP_TRANSPORT` | `stdio`     | Set to `http` for Streamable HTTP.   |
| `MCP_HTTP_HOST` | `127.0.0.1` | Only used when `MCP_TRANSPORT=http`. |
| `MCP_HTTP_PORT` | `3000`      | Only used when `MCP_TRANSPORT=http`. |

The HTTP transport binds to localhost by default. To expose it to other machines, set `MCP_HTTP_HOST=0.0.0.0` and ensure your network/firewall is configured appropriately.
```

- [ ] **Step 3: Verify the suite still passes**

Run: `yarn test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "docs: document OAuth client_credentials and HTTP transport env vars"
```

### Task 22: Merge `feat/oauth-and-http` into `main`

- [ ] **Step 1: Final verification**

Run: `yarn typecheck && yarn lint && yarn test`
Expected: all green.

- [ ] **Step 2: Smoke test stdio path**

Run: `SNOW_INSTANCE_URL=https://example.service-now.com SNOW_OAUTH_TOKEN=fake yarn build && SNOW_INSTANCE_URL=https://example.service-now.com SNOW_OAUTH_TOKEN=fake timeout 2 node dist/main.js < /dev/null; echo "exit=$?"`
Expected: process starts (no startup errors), waits on stdin, gets killed by `timeout` with `exit=124`. Any other non-zero exit indicates a regression — investigate.

- [ ] **Step 3: Smoke test HTTP path**

Run: `MCP_TRANSPORT=http MCP_HTTP_PORT=0 SNOW_INSTANCE_URL=https://example.service-now.com SNOW_OAUTH_TOKEN=fake timeout 2 node dist/main.js; echo "exit=$?"`
Expected: process starts, listens on an ephemeral port, exits via `timeout` with `exit=124`. If startup fails (`Error: ...`), capture the message and debug before merging.

- [ ] **Step 4: Merge**

```bash
git checkout main
git merge --no-ff feat/oauth-and-http -m "Merge feat/oauth-and-http: OAuth client_credentials + Streamable HTTP transport"
git status
```

Expected: `nothing to commit, working tree clean`.

- [ ] **Step 5: Bump version**

```bash
# Edit package.json version: "1.0.0" → "1.1.0"
git add package.json
git commit -m "chore: bump version to 1.1.0"
```

---

## Self-Review Summary

- All spec sections (CI, schema cache, OAuth + HTTP) are covered by tasks 1–22.
- No placeholders, no "TBD", no "see task N", no "handle appropriately".
- `AuthProvider` interface introduced in Task 10 is used consistently in Tasks 11–16.
- `CacheConfig` introduced in Task 4 is consumed in Task 7 and unchanged thereafter.
- `TransportConfig` introduced in Task 19 is consumed in Task 20.
- The implicit auth-selection priority (`client_credentials > token > basic`) is enforced in Task 15 and tested.
- The `cache: { ttlMs: 0, maxEntries: 0 }` test fixture pattern is repeated explicitly wherever new code requires it — no "similar to above".
- Task 14 deliberately leaves a typecheck-failing factory file uncommitted; Task 15 closes the gap and commits both together. The plan calls this out so engineers don't run `yarn typecheck` mid-task and report a false failure.
