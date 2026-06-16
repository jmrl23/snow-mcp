# Remove Redis / Add lru-cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `redis` npm dependency entirely, replace HTTP-transport schema caching with `lru-cache` (in-memory, TTL-aware), and make stdio transport fully stateless (no caching).

**Architecture:** The existing `SchemaCache<T>` interface is preserved unchanged; only the implementations behind it swap. `createSchemaCache` is rewritten to wrap `LRUCache` from `lru-cache`. A new `createNoopSchemaCache` (always returns `undefined`, ignores `set`/`clear`) is added and used by stdio. The Redis files, imports, config keys, and Docker service are all removed in later tasks once no code references them.

**Tech Stack:** TypeScript ESM, Node 24, `lru-cache` ^11, Vitest

---

### Task 1: Add lru-cache to package.json

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Install lru-cache and keep redis for now**

```bash
yarn add lru-cache
```

Expected: `lru-cache` appears in `dependencies` in `package.json`. The `redis` entry stays for now — removing it before the code stops importing it breaks typecheck.

- [ ] **Step 2: Run the full test suite to confirm nothing broke**

```bash
yarn test
```

Expected: All tests pass (no changes to source yet).

- [ ] **Step 3: Commit**

```bash
git add package.json yarn.lock
git commit -m "chore(deps): add lru-cache"
```

---

### Task 2: Rewrite schema-cache.ts with lru-cache + createNoopSchemaCache

**Files:**

- Modify: `src/servicenow/schema-cache.ts`
- Modify: `src/servicenow/schema-cache.test.ts`

- [ ] **Step 1: Replace schema-cache.ts with the lru-cache implementation**

Write `src/servicenow/schema-cache.ts`:

```ts
import { LRUCache } from 'lru-cache';

export interface SchemaCacheOptions {
  ttlMs: number;
  maxEntries: number;
}

export interface SchemaCache<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  clear(): Promise<void>;
}

export function createNoopSchemaCache<T>(): SchemaCache<T> {
  return {
    async get() {
      return undefined;
    },
    async set() {},
    async clear() {},
  };
}

export function createSchemaCache<T>(opts: SchemaCacheOptions): SchemaCache<T> {
  if (opts.ttlMs <= 0) return createNoopSchemaCache<T>();

  const cache = new LRUCache<string, T>({
    max: opts.maxEntries,
    ttl: opts.ttlMs,
    allowStale: false,
  });

  return {
    async get(key) {
      return cache.get(key);
    },
    async set(key, value) {
      cache.set(key, value);
    },
    async clear() {
      cache.clear();
    },
  };
}
```

- [ ] **Step 2: Update schema-cache.test.ts**

The TTL boundary semantics change: `lru-cache` treats an entry as stale when `elapsed > ttl` (strict greater-than), not `>=`. The old test that expected `undefined` at exactly `ttlMs` now expects the value to still be present; a separate test confirms it expires 1 ms later.

Write `src/servicenow/schema-cache.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createSchemaCache, createNoopSchemaCache } from './schema-cache.js';

describe('createSchemaCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns set value on get within ttl', async () => {
    const cache = createSchemaCache<number>({ ttlMs: 1000, maxEntries: 10 });
    await cache.set('a', 1);
    expect(await cache.get('a')).toBe(1);
  });

  it('returns undefined when entry has expired', async () => {
    const cache = createSchemaCache<number>({ ttlMs: 1000, maxEntries: 10 });
    await cache.set('a', 1);
    vi.advanceTimersByTime(1001);
    expect(await cache.get('a')).toBeUndefined();
  });

  it('is still valid at the exact ttl boundary (lru-cache uses strict > for staleness)', async () => {
    const cache = createSchemaCache<number>({ ttlMs: 1000, maxEntries: 10 });
    await cache.set('a', 1);
    vi.advanceTimersByTime(1000);
    expect(await cache.get('a')).toBe(1);
  });

  it('evicts oldest entry when maxEntries is reached', async () => {
    const cache = createSchemaCache<number>({ ttlMs: 60_000, maxEntries: 2 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.set('c', 3);
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBe(2);
    expect(await cache.get('c')).toBe(3);
  });

  it('refreshes insertion order on overwrite so re-set keys are not evicted first', async () => {
    const cache = createSchemaCache<number>({ ttlMs: 60_000, maxEntries: 2 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.set('a', 11); // refreshes 'a' to MRU
    await cache.set('c', 3); // evicts 'b' (now LRU), not 'a'
    expect(await cache.get('a')).toBe(11);
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('c')).toBe(3);
  });

  it('treats ttlMs:0 as disabled (get always undefined, set is a no-op)', async () => {
    const cache = createSchemaCache<number>({ ttlMs: 0, maxEntries: 10 });
    await cache.set('a', 1);
    expect(await cache.get('a')).toBeUndefined();
  });

  it('clear() removes a previously-set key', async () => {
    const cache = createSchemaCache<number>({ ttlMs: 1000, maxEntries: 10 });
    await cache.set('a', 1);
    await cache.clear();
    expect(await cache.get('a')).toBeUndefined();
  });

  it('clear() removes a second previously-set key', async () => {
    const cache = createSchemaCache<number>({ ttlMs: 1000, maxEntries: 10 });
    await cache.set('b', 2);
    await cache.clear();
    expect(await cache.get('b')).toBeUndefined();
  });
});

describe('createNoopSchemaCache', () => {
  it('get always returns undefined even after set', async () => {
    const cache = createNoopSchemaCache<number>();
    await cache.set('a', 1);
    expect(await cache.get('a')).toBeUndefined();
  });

  it('clear resolves without throwing', async () => {
    const cache = createNoopSchemaCache<number>();
    await expect(cache.clear()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the cache tests**

```bash
yarn test src/servicenow/schema-cache.test.ts
```

Expected: All 10 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/servicenow/schema-cache.ts src/servicenow/schema-cache.test.ts
git commit -m "feat(cache): replace Map-based cache with lru-cache, add createNoopSchemaCache"
```

---

### Task 3: Update server.ts — remove Redis, add createNoopServerCaches

**Files:**

- Modify: `src/mcp/server.ts`

- [ ] **Step 1: Rewrite server.ts**

Remove `import type { RedisClientType } from 'redis'`, the `RedisOps` type alias, `DESCRIBE_CACHE_NAMESPACE`, `LIST_CACHE_NAMESPACE`, and `createRedisServerCaches`. Add `createNoopServerCaches`. Import `createNoopSchemaCache` alongside `createSchemaCache`.

Write `src/mcp/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceNowClient } from '../servicenow/client.js';
import type { CacheConfig } from '../config.js';
import {
  createSchemaCache,
  createNoopSchemaCache,
  type SchemaCache,
} from '../servicenow/schema-cache.js';
import { createListTablesTool, type CachedRow } from './tools/list-tables.js';
import { createDescribeTableTool } from './tools/describe-table.js';
import { createQueryTableTool } from './tools/query-table.js';
import { createGetRecordTool } from './tools/get-record.js';
import { createGetAttachmentTool } from './tools/get-attachment.js';
import { createAggregateTool } from './tools/aggregate.js';
import { createRunSavedReportTool } from './tools/run-saved-report.js';
import { createGetUserContextTool } from './tools/get-user-context.js';
import { createTablesResource } from './resources/tables.js';

export interface ServerCaches {
  describeCache: SchemaCache<unknown>;
  listCache: SchemaCache<CachedRow[]>;
}

export function createServerCaches(cacheConfig: CacheConfig): ServerCaches {
  return {
    describeCache: createSchemaCache<unknown>(cacheConfig),
    listCache: createSchemaCache<CachedRow[]>(cacheConfig),
  };
}

export function createNoopServerCaches(): ServerCaches {
  return {
    describeCache: createNoopSchemaCache<unknown>(),
    listCache: createNoopSchemaCache<CachedRow[]>(),
  };
}

export function createMcpServer(client: ServiceNowClient, caches: ServerCaches): McpServer {
  // NOTE: keep in sync with package.json "version". tsconfig rootDir=./src blocks importing it directly.
  const server = new McpServer({ name: 'snow-mcp', version: '1.1.0' });
  const { describeCache, listCache } = caches;

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

- [ ] **Step 2: Run server tests**

```bash
yarn test src/mcp/server.test.ts
```

Expected: The single `createMcpServer` test passes (it already calls `createServerCaches` with `ttlMs: 0`, which now returns a noop cache — same observable behaviour).

- [ ] **Step 3: Commit**

```bash
git add src/mcp/server.ts
git commit -m "refactor(server): remove Redis cache factory, add createNoopServerCaches"
```

---

### Task 4: Update main.ts — remove Redis connection, wire correct caches

**Files:**

- Modify: `src/main.ts`

- [ ] **Step 1: Rewrite main.ts**

Remove `import { createClient } from 'redis'` and `createRedisServerCaches`. The HTTP branch no longer connects to Redis — it creates one `ServerCaches` (lru-cache backed) before the per-request factory, which closes over it. The stdio branch uses `createNoopServerCaches`. `buildServer()` (used only in tests, stdio only) also uses `createNoopServerCaches`.

Write `src/main.ts`:

```ts
import { loadConfig, type ServerConfig } from './config.js';
import { createServiceNowClient } from './servicenow/client.js';
import { createMcpServer, createServerCaches, createNoopServerCaches } from './mcp/server.js';
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

  // stdio is single-client and stateless: no caching.
  const server = createMcpServer(client, createNoopServerCaches());
  return { serverFactory: () => server, config };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const snowClient = createServiceNowClient(config);

  if (config.transport.kind === 'http') {
    // Caches are created once and shared across per-request server instances via closure.
    const caches = createServerCaches(config.cache);
    await connectTransport(() => createMcpServer(snowClient, caches), config.transport);
    return;
  }

  // stdio: stateless, no caching.
  const server = createMcpServer(snowClient, createNoopServerCaches());
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

- [ ] **Step 2: Run main tests**

```bash
yarn test src/main.test.ts
```

Expected: All 5 tests pass. The HTTP test still works because `loadConfig` still requires `REDIS_URL` for HTTP at this point (config.ts hasn't changed yet).

Note: do NOT run `yarn typecheck` here — `schema-cache-redis.test.ts` still imports `DESCRIBE_CACHE_NAMESPACE` which was removed from `server.ts` in Task 3. The full typecheck is deferred to Task 5 after those files are deleted.

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "refactor(main): remove Redis client, use lru-cache for HTTP and noop for stdio"
```

---

### Task 5: Delete Redis files and remove redis package

All code that imports from `redis` has been replaced. Now it's safe to delete the Redis source files and remove the package.

**Files:**

- Delete: `src/servicenow/schema-cache-redis.ts`
- Delete: `src/servicenow/schema-cache-redis.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Remove the redis npm package**

```bash
yarn remove redis
```

Expected: `redis` is removed from `dependencies` in `package.json` and `yarn.lock` is updated.

- [ ] **Step 2: Delete the Redis cache source files**

```bash
rm src/servicenow/schema-cache-redis.ts src/servicenow/schema-cache-redis.test.ts
```

- [ ] **Step 3: Typecheck to confirm no dangling imports**

```bash
yarn typecheck
```

Expected: No errors. If any file still imports from `redis` it will surface here.

- [ ] **Step 4: Run the full test suite**

```bash
yarn test
```

Expected: All tests pass (the deleted test file is simply gone from the suite).

- [ ] **Step 5: Commit**

```bash
git add package.json yarn.lock src/servicenow/schema-cache-redis.ts src/servicenow/schema-cache-redis.test.ts
git commit -m "chore(deps): remove redis package and schema-cache-redis files"
```

---

### Task 6: Update config.ts — remove RedisConfig and REDIS_URL

**Files:**

- Modify: `src/config.ts`

- [ ] **Step 1: Edit config.ts**

Remove the `RedisConfig` interface, `redis?: RedisConfig` from `ServerConfig`, and the entire `REDIS_URL` validation block (currently lines 99–106 in the original file). `SCHEMA_CACHE_TTL_MS` and `SCHEMA_CACHE_MAX_ENTRIES` stay.

Write `src/config.ts`:

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

export type TransportConfig =
  | { kind: 'stdio'; host: string; port: number }
  | { kind: 'http'; host: string; port: number; authToken: string };

export interface ServerConfig {
  instanceUrl: string;
  auth: AuthConfig;
  cache: CacheConfig;
  transport: TransportConfig;
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

  const transportKind = (env.MCP_TRANSPORT?.trim() || 'stdio') as string;
  if (transportKind !== 'stdio' && transportKind !== 'http') {
    throw new ConfigError(`MCP_TRANSPORT must be "stdio" or "http" (got: ${transportKind})`);
  }
  const httpHost = env.MCP_HTTP_HOST?.trim() || '127.0.0.1';
  const httpPort = parseIntEnv(env, 'MCP_HTTP_PORT', 3000, { min: 1 });
  if (httpPort > 65535) {
    throw new ConfigError(`MCP_HTTP_PORT must be <= 65535 (got: ${httpPort})`);
  }
  let transport: TransportConfig;
  if (transportKind === 'http') {
    const authToken = env.MCP_AUTH_TOKEN?.trim();
    if (!authToken) {
      throw new ConfigError('MCP_AUTH_TOKEN is required when MCP_TRANSPORT=http');
    }
    transport = { kind: 'http', host: httpHost, port: httpPort, authToken };
  } else {
    transport = { kind: 'stdio', host: httpHost, port: httpPort };
  }

  return { instanceUrl, auth, cache, transport };
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
    throw new ConfigError(`${name} must be >= ${bounds.min} (got: ${raw})`);
  }
  return n;
}
```

- [ ] **Step 2: Run typecheck**

```bash
yarn typecheck
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "refactor(config): remove RedisConfig and REDIS_URL requirement"
```

---

### Task 7: Update config.test.ts — remove Redis-related tests

**Files:**

- Modify: `src/config.test.ts`

The `HTTP_BASE` constant currently includes `REDIS_URL`. Remove it. Drop the 4 tests that assert Redis-specific config behaviour: the two that expect `ConfigError` when `REDIS_URL` is missing/blank, the one that asserts `cfg.redis.url`, and the one that asserts `cfg.redis` is `undefined` for stdio.

- [ ] **Step 1: Rewrite config.test.ts**

Write `src/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { ConfigError } from './errors.js';

const BASE = { SNOW_INSTANCE_URL: 'https://example.service-now.com' };

describe('loadConfig', () => {
  it('throws ConfigError naming every missing variable when env is empty', () => {
    const err = (() => {
      try {
        loadConfig({});
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain('SNOW_INSTANCE_URL');
    expect((err as Error).message).toContain('SNOW_OAUTH_CLIENT_ID');
    expect((err as Error).message).toContain('SNOW_OAUTH_CLIENT_SECRET');
    expect((err as Error).message).toContain('SNOW_OAUTH_TOKEN');
    expect((err as Error).message).toContain('SNOW_USER');
    expect((err as Error).message).toContain('SNOW_PASSWORD');
  });

  it('rejects non-https URLs', () => {
    expect(() =>
      loadConfig({ SNOW_INSTANCE_URL: 'http://example.service-now.com', SNOW_OAUTH_TOKEN: 't' }),
    ).toThrow(/https/);
  });

  it('strips trailing slash from instance URL', () => {
    const cfg = loadConfig({
      SNOW_INSTANCE_URL: 'https://example.service-now.com/',
      SNOW_OAUTH_TOKEN: 't',
    });
    expect(cfg.instanceUrl).toBe('https://example.service-now.com');
  });

  it('selects bearer auth when SNOW_OAUTH_TOKEN is set', () => {
    const cfg = loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 'abc' });
    expect(cfg.auth).toEqual({ kind: 'bearer', token: 'abc' });
  });

  it('selects bearer over basic when both are present', () => {
    const cfg = loadConfig({
      ...BASE,
      SNOW_OAUTH_TOKEN: 'abc',
      SNOW_USER: 'u',
      SNOW_PASSWORD: 'p',
    });
    expect(cfg.auth).toEqual({ kind: 'bearer', token: 'abc' });
  });

  it('selects basic auth when only SNOW_USER + SNOW_PASSWORD are set', () => {
    const cfg = loadConfig({ ...BASE, SNOW_USER: 'u', SNOW_PASSWORD: 'p' });
    expect(cfg.auth).toEqual({ kind: 'basic', user: 'u', password: 'p' });
  });

  it('rejects when only SNOW_USER is set without SNOW_PASSWORD', () => {
    expect(() => loadConfig({ ...BASE, SNOW_USER: 'u' })).toThrow(ConfigError);
  });

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
    expect(() =>
      loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't', SCHEMA_CACHE_TTL_MS: 'abc' }),
    ).toThrow(/SCHEMA_CACHE_TTL_MS/);
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

  it('defaults transport to stdio on 127.0.0.1:3000', () => {
    const cfg = loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't' });
    expect(cfg.transport).toEqual({ kind: 'stdio', host: '127.0.0.1', port: 3000 });
  });

  const HTTP_BASE = {
    ...BASE,
    SNOW_OAUTH_TOKEN: 't',
    MCP_TRANSPORT: 'http',
    MCP_AUTH_TOKEN: 'secret',
  };

  it('parses MCP_TRANSPORT=http with default host and port', () => {
    const cfg = loadConfig(HTTP_BASE);
    expect(cfg.transport).toEqual({
      kind: 'http',
      host: '127.0.0.1',
      port: 3000,
      authToken: 'secret',
    });
  });

  it('parses MCP_HTTP_PORT and MCP_HTTP_HOST', () => {
    const cfg = loadConfig({
      ...HTTP_BASE,
      MCP_HTTP_PORT: '8080',
      MCP_HTTP_HOST: '0.0.0.0',
    });
    expect(cfg.transport).toEqual({
      kind: 'http',
      host: '0.0.0.0',
      port: 8080,
      authToken: 'secret',
    });
  });

  it('trims MCP_AUTH_TOKEN and stores it on the http transport config', () => {
    const cfg = loadConfig({ ...HTTP_BASE, MCP_AUTH_TOKEN: '  my-token  ' });
    expect(cfg.transport).toEqual({
      kind: 'http',
      host: '127.0.0.1',
      port: 3000,
      authToken: 'my-token',
    });
  });

  it('throws ConfigError when MCP_TRANSPORT=http and MCP_AUTH_TOKEN is missing', () => {
    expect(() =>
      loadConfig({
        ...BASE,
        SNOW_OAUTH_TOKEN: 't',
        MCP_TRANSPORT: 'http',
      }),
    ).toThrow(ConfigError);
  });

  it('throws ConfigError when MCP_TRANSPORT=http and MCP_AUTH_TOKEN is blank whitespace', () => {
    expect(() =>
      loadConfig({
        ...BASE,
        SNOW_OAUTH_TOKEN: 't',
        MCP_TRANSPORT: 'http',
        MCP_AUTH_TOKEN: '   ',
      }),
    ).toThrow(ConfigError);
  });

  it('loads successfully for stdio transport without MCP_AUTH_TOKEN', () => {
    const cfg = loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't' });
    expect(cfg.transport.kind).toBe('stdio');
  });

  it('rejects MCP_TRANSPORT values other than stdio or http', () => {
    expect(() => loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't', MCP_TRANSPORT: 'ws' })).toThrow(
      /MCP_TRANSPORT/,
    );
  });

  it('rejects MCP_HTTP_PORT below 1', () => {
    expect(() => loadConfig({ ...HTTP_BASE, MCP_HTTP_PORT: '0' })).toThrow(/MCP_HTTP_PORT/);
  });

  it('rejects MCP_HTTP_PORT above 65535', () => {
    expect(() => loadConfig({ ...HTTP_BASE, MCP_HTTP_PORT: '70000' })).toThrow(/MCP_HTTP_PORT/);
  });
});
```

- [ ] **Step 2: Run config tests**

```bash
yarn test src/config.test.ts
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/config.test.ts
git commit -m "test(config): remove REDIS_URL test cases"
```

---

### Task 8: Update main.test.ts — remove REDIS_URL reference

**Files:**

- Modify: `src/main.test.ts`

The HTTP-transport test passes `REDIS_URL` in the env object. After config.ts no longer validates it, the value is simply ignored — but the test should be clean.

- [ ] **Step 1: Edit the HTTP test case in main.test.ts**

The only change is removing `REDIS_URL: 'redis://redis:6379'` from the `buildServer` HTTP test:

```ts
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
```

- [ ] **Step 2: Run main tests**

```bash
yarn test src/main.test.ts
```

Expected: All 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/main.test.ts
git commit -m "test(main): remove REDIS_URL from HTTP transport test fixture"
```

---

### Task 9: Update docker-compose files and .env.example

**Files:**

- Modify: `docker-compose.yml`
- Modify: `docker-compose.ghcr.yml`
- Modify: `.env.example`

- [ ] **Step 1: Rewrite docker-compose.yml**

Remove the `redis:` service, `depends_on: redis`, and `REDIS_URL` from environment.

Write `docker-compose.yml`:

```yaml
services:
  snow-mcp:
    build: .
    image: snow-mcp:local
    container_name: snow-mcp
    restart: unless-stopped
    # Provide ServiceNow credentials via your shell or an orchestrator
    # secret. compose substitutes ${VAR} from your shell env. If you prefer
    # a file, uncomment env_file below — compose also auto-loads .env from
    # the project dir for variable substitution, but not as container env.
    env_file:
      - .env
    environment:
      SNOW_INSTANCE_URL: ${SNOW_INSTANCE_URL:?SNOW_INSTANCE_URL is required}
      SNOW_USER: ${SNOW_USER:-}
      SNOW_PASSWORD: ${SNOW_PASSWORD:-}
      SNOW_OAUTH_TOKEN: ${SNOW_OAUTH_TOKEN:-}
      SNOW_OAUTH_CLIENT_ID: ${SNOW_OAUTH_CLIENT_ID:-}
      SNOW_OAUTH_CLIENT_SECRET: ${SNOW_OAUTH_CLIENT_SECRET:-}
      MCP_TRANSPORT: http
      MCP_HTTP_HOST: 0.0.0.0
      MCP_HTTP_PORT: 17880
      MCP_AUTH_TOKEN: ${MCP_AUTH_TOKEN:?MCP_AUTH_TOKEN is required when MCP_TRANSPORT=http}
      SCHEMA_CACHE_TTL_MS: ${SCHEMA_CACHE_TTL_MS:-}
      SCHEMA_CACHE_MAX_ENTRIES: ${SCHEMA_CACHE_MAX_ENTRIES:-}
    ports:
      - '17880:17880'
```

- [ ] **Step 2: Rewrite docker-compose.ghcr.yml**

Write `docker-compose.ghcr.yml`:

```yaml
services:
  snow-mcp:
    image: ghcr.io/jmrl23/snow-mcp:main
    container_name: snow-mcp
    restart: unless-stopped
    # Provide ServiceNow credentials via your shell or an orchestrator
    # secret. compose substitutes ${VAR} from your shell env. If you prefer
    # a file, uncomment env_file below — compose also auto-loads .env from
    # the project dir for variable substitution, but not as container env.
    env_file:
      - .env
    environment:
      SNOW_INSTANCE_URL: ${SNOW_INSTANCE_URL:?SNOW_INSTANCE_URL is required}
      SNOW_USER: ${SNOW_USER:-}
      SNOW_PASSWORD: ${SNOW_PASSWORD:-}
      SNOW_OAUTH_TOKEN: ${SNOW_OAUTH_TOKEN:-}
      SNOW_OAUTH_CLIENT_ID: ${SNOW_OAUTH_CLIENT_ID:-}
      SNOW_OAUTH_CLIENT_SECRET: ${SNOW_OAUTH_CLIENT_SECRET:-}
      MCP_TRANSPORT: http
      MCP_HTTP_HOST: 0.0.0.0
      MCP_HTTP_PORT: 17880
      MCP_AUTH_TOKEN: ${MCP_AUTH_TOKEN:?MCP_AUTH_TOKEN is required when MCP_TRANSPORT=http}
      SCHEMA_CACHE_TTL_MS: ${SCHEMA_CACHE_TTL_MS:-}
      SCHEMA_CACHE_MAX_ENTRIES: ${SCHEMA_CACHE_MAX_ENTRIES:-}
    ports:
      - '17880:17880'
```

- [ ] **Step 3: Remove REDIS_URL from .env.example**

Open `.env.example` and delete the `REDIS_URL=` line. The file is committed intentionally as a reference — keep all other env vars.

- [ ] **Step 4: Check README for REDIS_URL references**

```bash
grep -n "REDIS_URL\|redis" README.md
```

Update any mentions of `REDIS_URL`, the Redis service, or Docker Compose Redis setup instructions to reflect that Redis is no longer used.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml docker-compose.ghcr.yml .env.example README.md
git commit -m "chore: remove Redis service from docker-compose and env config"
```

---

### Task 10: Final verification

- [ ] **Step 1: Full typecheck**

```bash
yarn typecheck
```

Expected: No errors.

- [ ] **Step 2: Full test suite**

```bash
yarn test
```

Expected: All tests pass. Confirm the deleted Redis test file is absent from the output.

- [ ] **Step 3: Lint**

```bash
yarn lint
```

Expected: No errors.

- [ ] **Step 4: Confirm redis is gone from node_modules**

```bash
ls node_modules | grep redis
```

Expected: No output (redis package is not installed).
