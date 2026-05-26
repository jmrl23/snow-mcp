# snow-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a strictly read-only ServiceNow MCP server exposing 8 tools and 1 resource over stdio, with the read-only invariant enforced at the type, runtime, and lint layers.

**Architecture:** Single Node 24 ESM process. `.env` → `config.ts` → `http/client.ts` (GET-only fetch wrapper) → `servicenow/*-api.ts` (typed REST wrappers) → `mcp/tools/*` + `mcp/resources/*` (thin MCP adapters) → `McpServer` over `StdioServerTransport`. Every layer has its own Vitest tests; no live ServiceNow calls in CI.

**Tech Stack:** TypeScript strict, Node 24, `@modelcontextprotocol/sdk@^1.29`, `zod@^3.25`, Vitest, ESLint (typescript-eslint), Prettier, yarn.

**Spec:** `docs/superpowers/specs/2026-05-26-snow-mcp-design.md` (commit `8d74106`).

**Conventions used in every task:**

- Files use kebab-case (per `.claude/rules/code-quality.md`).
- Test files live next to source as `*.test.ts`.
- Imports are ESM with explicit `.js` extensions (NodeNext requirement).
- Run a single test: `yarn test src/path/to/file.test.ts`.
- After every task: `yarn typecheck && yarn lint && yarn test` must all pass before committing.

---

## Task 0: Setup — add zod, ESLint guard, test scaffolding

**Files:**

- Modify: `package.json` (add `zod`)
- Modify: `eslint.config.js` (add `no-restricted-globals` rule for `fetch`)
- Create: `src/lint-fence.test.ts` (asserts the ESLint rule actually catches a `fetch` call outside `http/client.ts`)

- [ ] **Step 1: Add zod as a direct dependency**

```bash
yarn add zod
```

Expected: zod is moved into `dependencies` in `package.json`, peer-dep warning from `@modelcontextprotocol/sdk` is gone after `yarn install`.

- [ ] **Step 2: Modify `eslint.config.js` to forbid `fetch` outside `src/http/client.ts`**

Replace the contents of `eslint.config.js` with:

```js
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'fetch() is only allowed inside src/http/client.ts. Use the HttpClient abstraction.',
        },
      ],
    },
  },
  {
    files: ['src/http/client.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  prettier,
);
```

- [ ] **Step 3: Write a test that proves the lint fence works**

Create `src/lint-fence.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('eslint no-restricted-globals fetch fence', () => {
  it('flags fetch() in a file outside src/http/', () => {
    const dir = join(tmpdir(), `lint-fence-${Date.now()}`);
    mkdirSync(join(dir, 'src'), { recursive: true });
    const bad = join(dir, 'src', 'bad.ts');
    writeFileSync(bad, "export const x = () => fetch('https://example.com');\n");
    try {
      execFileSync('npx', ['eslint', '--no-eslintrc', '-c', 'eslint.config.js', bad], {
        encoding: 'utf-8',
        cwd: process.cwd(),
      });
      throw new Error('expected eslint to fail');
    } catch (err) {
      const out = String(
        (err as { stdout?: string; message: string }).stdout ?? (err as Error).message,
      );
      expect(out).toMatch(/fetch\(\) is only allowed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `yarn test src/lint-fence.test.ts`
Expected: 1 test passing.

- [ ] **Step 5: Run the full check, then commit**

```bash
yarn typecheck && yarn lint && yarn test
git add package.json yarn.lock eslint.config.js src/lint-fence.test.ts
git commit -m "chore: add zod, restrict fetch to http/client.ts via eslint"
```

---

## Task 1: Error classes

**Files:**

- Create: `src/errors.ts`
- Create: `src/errors.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  ReadOnlyViolationError,
  ServiceNowAuthError,
  ServiceNowClientError,
  ServiceNowNotFoundError,
  ServiceNowRateLimitError,
  ServiceNowServerError,
} from './errors.js';

describe('error classes', () => {
  it('ConfigError has correct name and message', () => {
    const e = new ConfigError('missing FOO');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ConfigError');
    expect(e.message).toBe('missing FOO');
  });

  it('ReadOnlyViolationError mentions the method', () => {
    const e = new ReadOnlyViolationError('POST');
    expect(e.name).toBe('ReadOnlyViolationError');
    expect(e.message).toContain('POST');
  });

  it('ServiceNowAuthError carries status and body', () => {
    const e = new ServiceNowAuthError(401, { error: 'invalid' }, 'auth failed');
    expect(e.status).toBe(401);
    expect(e.body).toEqual({ error: 'invalid' });
    expect(e.name).toBe('ServiceNowAuthError');
  });

  it('ServiceNowNotFoundError, ClientError, ServerError have correct names', () => {
    expect(new ServiceNowNotFoundError(404, null, 'gone').name).toBe('ServiceNowNotFoundError');
    expect(new ServiceNowClientError(400, null, 'bad').name).toBe('ServiceNowClientError');
    expect(new ServiceNowServerError(500, null, 'oops').name).toBe('ServiceNowServerError');
  });

  it('ServiceNowRateLimitError records retry-after', () => {
    const e = new ServiceNowRateLimitError(429, null, 'slow down', 5000);
    expect(e.retryAfterMs).toBe(5000);
    expect(e.name).toBe('ServiceNowRateLimitError');
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/errors.test.ts`
Expected: FAIL — cannot find module `./errors.js`.

- [ ] **Step 3: Implement `src/errors.ts`**

```ts
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class ReadOnlyViolationError extends Error {
  constructor(method: string) {
    super(`Read-only violation: HTTP ${method} is not allowed. snow-mcp issues GET requests only.`);
    this.name = 'ReadOnlyViolationError';
  }
}

export class ServiceNowError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'ServiceNowError';
  }
}

export class ServiceNowAuthError extends ServiceNowError {
  constructor(status: number, body: unknown, message: string) {
    super(status, body, message);
    this.name = 'ServiceNowAuthError';
  }
}

export class ServiceNowNotFoundError extends ServiceNowError {
  constructor(status: number, body: unknown, message: string) {
    super(status, body, message);
    this.name = 'ServiceNowNotFoundError';
  }
}

export class ServiceNowRateLimitError extends ServiceNowError {
  constructor(
    status: number,
    body: unknown,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(status, body, message);
    this.name = 'ServiceNowRateLimitError';
  }
}

export class ServiceNowServerError extends ServiceNowError {
  constructor(status: number, body: unknown, message: string) {
    super(status, body, message);
    this.name = 'ServiceNowServerError';
  }
}

export class ServiceNowClientError extends ServiceNowError {
  constructor(status: number, body: unknown, message: string) {
    super(status, body, message);
    this.name = 'ServiceNowClientError';
  }
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/errors.test.ts`
Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/errors.ts src/errors.test.ts
git commit -m "feat: add typed error classes"
```

---

## Task 2: Config loader

**Files:**

- Create: `src/config.ts`
- Create: `src/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/config.test.ts`:

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
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/config.test.ts`
Expected: FAIL — module `./config.js` not found.

- [ ] **Step 3: Implement `src/config.ts`**

```ts
import { ConfigError } from './errors.js';

export type AuthConfig =
  | { kind: 'bearer'; token: string }
  | { kind: 'basic'; user: string; password: string };

export interface ServerConfig {
  instanceUrl: string;
  auth: AuthConfig;
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

  return { instanceUrl, auth };
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/config.test.ts`
Expected: 7 tests passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/config.ts src/config.test.ts
git commit -m "feat: load and validate snow config from env"
```

---

## Task 3: HTTP client with read-only guard

**Files:**

- Create: `src/http/client.ts`
- Create: `src/http/client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/http/client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createHttpClient } from './client.js';
import { ReadOnlyViolationError } from '../errors.js';
import type { ServerConfig } from '../config.js';

const cfgBasic: ServerConfig = {
  instanceUrl: 'https://example.service-now.com',
  auth: { kind: 'basic', user: 'u', password: 'p' },
};
const cfgBearer: ServerConfig = {
  instanceUrl: 'https://example.service-now.com',
  auth: { kind: 'bearer', token: 'abc' },
};

function fakeFetch(): {
  fn: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

describe('createHttpClient', () => {
  it('request() issues GET with full URL composed from instance + path', async () => {
    const { fn, calls } = fakeFetch();
    const client = createHttpClient(cfgBasic, fn);
    await client.request('/api/now/table/incident');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://example.service-now.com/api/now/table/incident');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('appends query parameters, skipping undefined', async () => {
    const { fn, calls } = fakeFetch();
    const client = createHttpClient(cfgBasic, fn);
    await client.request('/api/now/table/incident', {
      query: { sysparm_limit: '25', sysparm_query: undefined, sysparm_offset: '0' },
    });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('sysparm_limit')).toBe('25');
    expect(url.searchParams.get('sysparm_offset')).toBe('0');
    expect(url.searchParams.has('sysparm_query')).toBe(false);
  });

  it('injects Basic auth header', async () => {
    const { fn, calls } = fakeFetch();
    const client = createHttpClient(cfgBasic, fn);
    await client.request('/x');
    const headers = new Headers(calls[0]!.init!.headers);
    expect(headers.get('authorization')).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect(headers.get('accept')).toBe('application/json');
  });

  it('injects Bearer auth header', async () => {
    const { fn, calls } = fakeFetch();
    const client = createHttpClient(cfgBearer, fn);
    await client.request('/x');
    const headers = new Headers(calls[0]!.init!.headers);
    expect(headers.get('authorization')).toBe('Bearer abc');
  });

  it('requestRaw throws ReadOnlyViolationError for POST', async () => {
    const { fn } = fakeFetch();
    const client = createHttpClient(cfgBasic, fn);
    await expect(client.requestRaw('POST' as 'GET', '/x')).rejects.toBeInstanceOf(
      ReadOnlyViolationError,
    );
  });

  it('requestRaw throws for PUT, PATCH, DELETE', async () => {
    const { fn } = fakeFetch();
    const client = createHttpClient(cfgBasic, fn);
    for (const m of ['PUT', 'PATCH', 'DELETE'] as const) {
      await expect(client.requestRaw(m as 'GET', '/x')).rejects.toBeInstanceOf(
        ReadOnlyViolationError,
      );
    }
  });

  it('redact() strips Authorization header values and known secret-named keys', async () => {
    const { redact } = await import('./client.js');
    const out = redact({
      headers: { Authorization: 'Bearer secret', 'X-Other': 'ok' },
      env: { SNOW_PASSWORD: 'pw', SNOW_OAUTH_TOKEN: 'tok', SNOW_INSTANCE_URL: 'url' },
      nested: { authorization: 'Basic xxx', other: 'visible' },
    }) as Record<string, unknown>;
    const s = JSON.stringify(out);
    expect(s).not.toContain('secret');
    expect(s).not.toContain('pw');
    expect(s).not.toContain('tok');
    expect(s).not.toContain('Basic xxx');
    expect(s).toContain('visible');
    expect(s).toContain('url');
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/http/client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/http/client.ts`**

```ts
import { ReadOnlyViolationError } from '../errors.js';
import type { AuthConfig, ServerConfig } from '../config.js';

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
): HttpClient {
  const authHeader = buildAuthHeader(config.auth);

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
    const headers = new Headers(opts.headers);
    headers.set('Authorization', authHeader);
    headers.set('Accept', 'application/json');
    return fetchImpl(url.toString(), { method, headers, signal: opts.signal });
  }

  return {
    request: (path, opts) => requestRaw('GET', path, opts),
    requestRaw,
  };
}

function buildAuthHeader(auth: AuthConfig): string {
  if (auth.kind === 'bearer') return `Bearer ${auth.token}`;
  return `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString('base64')}`;
}

const REDACTED = '[REDACTED]';
const SECRET_KEY_PATTERNS = [
  /^authorization$/i,
  /^snow_password$/i,
  /^snow_oauth_token$/i,
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

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/http/client.test.ts`
Expected: 7 tests passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/http/client.ts src/http/client.test.ts
git commit -m "feat: GET-only HTTP client with auth injection and redaction"
```

---

## Task 4: Retry wrapper

**Files:**

- Create: `src/http/retry.ts`
- Create: `src/http/retry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/http/retry.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { withRetry, parseRetryAfter } from './retry.js';

function makeFetch(responses: Array<() => Promise<Response>>): typeof fetch {
  let i = 0;
  return (async () => {
    const next = responses[i] ?? responses[responses.length - 1]!;
    i++;
    return next();
  }) as typeof fetch;
}

describe('withRetry', () => {
  it('returns successful response without retry', async () => {
    const fn = vi.fn(async () => new Response('ok', { status: 200 }));
    const res = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitterPct: 0 });
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx and eventually succeeds', async () => {
    const fn = vi.fn();
    fn.mockResolvedValueOnce(new Response('err', { status: 500 }));
    fn.mockResolvedValueOnce(new Response('err', { status: 503 }));
    fn.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitterPct: 0 });
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries on 429 and eventually succeeds', async () => {
    const fn = vi.fn();
    fn.mockResolvedValueOnce(new Response('rl', { status: 429 }));
    fn.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitterPct: 0 });
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('returns the last 5xx response after maxAttempts', async () => {
    const fn = vi.fn(async () => new Response('err', { status: 502 }));
    const res = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitterPct: 0 });
    expect(res.status).toBe(502);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry 4xx (except 429)', async () => {
    const fn = vi.fn(async () => new Response('bad', { status: 400 }));
    const res = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitterPct: 0 });
    expect(res.status).toBe(400);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries network errors like 5xx', async () => {
    const fn = vi.fn();
    fn.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'ECONNRESET' }));
    fn.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitterPct: 0 });
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('parseRetryAfter handles delta-seconds and HTTP-date', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('   12   ')).toBe(12000);
    expect(parseRetryAfter('not a number')).toBeUndefined();
    const future = new Date(Date.now() + 3000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(5000);
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/http/retry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/http/retry.ts`**

```ts
export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  jitterPct: number;
}

const DEFAULT: RetryOptions = { maxAttempts: 3, baseDelayMs: 200, jitterPct: 0.25 };

export async function withRetry(
  fn: () => Promise<Response>,
  opts: Partial<RetryOptions> = {},
): Promise<Response> {
  const cfg = { ...DEFAULT, ...opts };
  let lastResponse: Response | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
    try {
      const res = await fn();
      if (!shouldRetryStatus(res.status) || attempt === cfg.maxAttempts - 1) {
        return res;
      }
      lastResponse = res;
      const delay =
        res.status === 429
          ? (parseRetryAfter(res.headers.get('retry-after') ?? '') ?? backoffMs(attempt, cfg))
          : backoffMs(attempt, cfg);
      await sleep(delay);
    } catch (err) {
      if (!isRetryableError(err) || attempt === cfg.maxAttempts - 1) {
        throw err;
      }
      lastError = err;
      await sleep(backoffMs(attempt, cfg));
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError;
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_SOCKET'
  );
}

function backoffMs(attempt: number, cfg: RetryOptions): number {
  const base = cfg.baseDelayMs * Math.pow(4, attempt);
  const jitter = base * cfg.jitterPct * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function parseRetryAfter(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/http/retry.test.ts`
Expected: 7 tests passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/http/retry.ts src/http/retry.test.ts
git commit -m "feat: exponential backoff retry helper for HTTP responses"
```

---

## Task 5: Response → error translation

**Files:**

- Create: `src/http/translate-error.ts`
- Create: `src/http/translate-error.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/http/translate-error.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ensureOk } from './translate-error.js';
import {
  ServiceNowAuthError,
  ServiceNowClientError,
  ServiceNowNotFoundError,
  ServiceNowRateLimitError,
  ServiceNowServerError,
} from '../errors.js';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('ensureOk', () => {
  it('returns response unchanged on 200', async () => {
    const r = jsonResponse(200, { ok: true });
    await expect(ensureOk(r)).resolves.toBe(r);
  });

  it('throws ServiceNowAuthError on 401 and 403', async () => {
    await expect(ensureOk(jsonResponse(401, { error: 'no' }))).rejects.toBeInstanceOf(
      ServiceNowAuthError,
    );
    await expect(ensureOk(jsonResponse(403, { error: 'no' }))).rejects.toBeInstanceOf(
      ServiceNowAuthError,
    );
  });

  it('throws ServiceNowNotFoundError on 404', async () => {
    await expect(ensureOk(jsonResponse(404, { error: 'gone' }))).rejects.toBeInstanceOf(
      ServiceNowNotFoundError,
    );
  });

  it('throws ServiceNowClientError on other 4xx', async () => {
    await expect(ensureOk(jsonResponse(400, { error: 'bad' }))).rejects.toBeInstanceOf(
      ServiceNowClientError,
    );
    await expect(ensureOk(jsonResponse(409, { error: 'conflict' }))).rejects.toBeInstanceOf(
      ServiceNowClientError,
    );
  });

  it('throws ServiceNowRateLimitError on 429 with retry-after', async () => {
    const r = jsonResponse(429, { error: 'rl' }, { 'retry-after': '7' });
    try {
      await ensureOk(r);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceNowRateLimitError);
      expect((e as ServiceNowRateLimitError).retryAfterMs).toBe(7000);
    }
  });

  it('throws ServiceNowServerError on 5xx', async () => {
    await expect(ensureOk(jsonResponse(500, { error: 'oops' }))).rejects.toBeInstanceOf(
      ServiceNowServerError,
    );
    await expect(ensureOk(jsonResponse(503, { error: 'busy' }))).rejects.toBeInstanceOf(
      ServiceNowServerError,
    );
  });

  it('handles non-JSON bodies without crashing', async () => {
    const r = new Response('plain text', { status: 500 });
    await expect(ensureOk(r)).rejects.toBeInstanceOf(ServiceNowServerError);
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/http/translate-error.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/http/translate-error.ts`**

```ts
import {
  ServiceNowAuthError,
  ServiceNowClientError,
  ServiceNowNotFoundError,
  ServiceNowRateLimitError,
  ServiceNowServerError,
} from '../errors.js';
import { parseRetryAfter } from './retry.js';

export async function ensureOk(res: Response): Promise<Response> {
  if (res.ok) return res;
  const body = await parseBody(res);
  const msg = `ServiceNow responded ${res.status} ${res.statusText}`.trim();
  if (res.status === 401 || res.status === 403) {
    throw new ServiceNowAuthError(res.status, body, msg);
  }
  if (res.status === 404) {
    throw new ServiceNowNotFoundError(res.status, body, msg);
  }
  if (res.status === 429) {
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after') ?? '');
    throw new ServiceNowRateLimitError(res.status, body, msg, retryAfterMs);
  }
  if (res.status >= 500) {
    throw new ServiceNowServerError(res.status, body, msg);
  }
  throw new ServiceNowClientError(res.status, body, msg);
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/http/translate-error.test.ts`
Expected: 7 tests passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/http/translate-error.ts src/http/translate-error.test.ts
git commit -m "feat: translate ServiceNow HTTP responses to typed errors"
```

---

## Task 6: Table API wrapper

**Files:**

- Create: `src/servicenow/table-api.ts`
- Create: `src/servicenow/table-api.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/servicenow/table-api.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createTableApi } from './table-api.js';
import type { HttpClient } from '../http/client.js';

function mockClient(response: Response): {
  client: HttpClient;
  calls: Array<{ path: string; query?: Record<string, string | undefined> }>;
} {
  const calls: Array<{ path: string; query?: Record<string, string | undefined> }> = [];
  const client: HttpClient = {
    request: vi.fn(async (path: string, opts) => {
      calls.push({ path, query: opts?.query });
      return response;
    }),
    requestRaw: vi.fn(async (_m, path, opts) => {
      calls.push({ path, query: opts?.query });
      return response;
    }),
  };
  return { client, calls };
}

function jsonResp(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('TableApi.query', () => {
  it('GETs /api/now/table/<name> with sysparm_* params', async () => {
    const { client, calls } = mockClient(jsonResp({ result: [{ sys_id: '1' }, { sys_id: '2' }] }));
    const api = createTableApi(client);
    const out = await api.query('incident', {
      sysparmQuery: 'priority=1',
      fields: ['sys_id', 'number'],
      limit: 25,
      offset: 0,
      displayValue: 'false',
    });
    expect(calls[0]?.path).toBe('/api/now/table/incident');
    expect(calls[0]?.query?.sysparm_query).toBe('priority=1');
    expect(calls[0]?.query?.sysparm_fields).toBe('sys_id,number');
    expect(calls[0]?.query?.sysparm_limit).toBe('25');
    expect(calls[0]?.query?.sysparm_offset).toBe('0');
    expect(calls[0]?.query?.sysparm_display_value).toBe('false');
    expect(out.records).toHaveLength(2);
  });

  it('includes next_offset when ServiceNow signals more results via X-Total-Count', async () => {
    const { client } = mockClient(
      jsonResp({ result: [{ sys_id: '1' }] }, 200, { 'x-total-count': '50' }),
    );
    const api = createTableApi(client);
    const out = await api.query('incident', { limit: 1, offset: 0 });
    expect(out.next_offset).toBe(1);
    expect(out.total).toBe(50);
  });

  it('omits next_offset when X-Total-Count says we have everything', async () => {
    const { client } = mockClient(
      jsonResp({ result: [{ sys_id: '1' }] }, 200, { 'x-total-count': '1' }),
    );
    const api = createTableApi(client);
    const out = await api.query('incident', { limit: 25, offset: 0 });
    expect(out.next_offset).toBeUndefined();
    expect(out.total).toBe(1);
  });

  it('getRecord GETs /api/now/table/<name>/<sys_id>', async () => {
    const { client, calls } = mockClient(jsonResp({ result: { sys_id: 'abc', number: 'INC1' } }));
    const api = createTableApi(client);
    const rec = await api.getRecord('incident', 'abc', ['sys_id', 'number']);
    expect(calls[0]?.path).toBe('/api/now/table/incident/abc');
    expect(calls[0]?.query?.sysparm_fields).toBe('sys_id,number');
    expect(rec).toEqual({ sys_id: 'abc', number: 'INC1' });
  });

  it('throws when an error response is returned (delegates to ensureOk)', async () => {
    const { client } = mockClient(jsonResp({ error: 'bad' }, 401));
    const api = createTableApi(client);
    await expect(api.query('incident', {})).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/servicenow/table-api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/servicenow/table-api.ts`**

```ts
import type { HttpClient } from '../http/client.js';
import { ensureOk } from '../http/translate-error.js';

export interface QueryOptions {
  sysparmQuery?: string;
  fields?: string[];
  limit?: number;
  offset?: number;
  displayValue?: 'true' | 'false' | 'all';
}

export interface QueryResult<T = Record<string, unknown>> {
  records: T[];
  total?: number;
  next_offset?: number;
}

export interface TableApi {
  query<T = Record<string, unknown>>(table: string, opts: QueryOptions): Promise<QueryResult<T>>;
  getRecord<T = Record<string, unknown>>(
    table: string,
    sysId: string,
    fields?: string[],
  ): Promise<T>;
}

export function createTableApi(http: HttpClient): TableApi {
  return {
    async query(table, opts) {
      const limit = opts.limit ?? 25;
      const offset = opts.offset ?? 0;
      const res = await http.request(`/api/now/table/${encodeURIComponent(table)}`, {
        query: {
          sysparm_query: opts.sysparmQuery,
          sysparm_fields: opts.fields?.length ? opts.fields.join(',') : undefined,
          sysparm_limit: String(limit),
          sysparm_offset: String(offset),
          sysparm_display_value: opts.displayValue ?? 'false',
        },
      });
      const ok = await ensureOk(res);
      const totalHeader = ok.headers.get('x-total-count');
      const total = totalHeader ? Number(totalHeader) : undefined;
      const body = (await ok.json()) as { result?: unknown[] };
      const records = (body.result ?? []) as Record<string, unknown>[];
      const next_offset =
        total !== undefined && offset + records.length < total
          ? offset + records.length
          : undefined;
      return {
        records: records as unknown as ReturnType<typeof Object>[],
        total,
        next_offset,
      } as QueryResult;
    },

    async getRecord(table, sysId, fields) {
      const res = await http.request(
        `/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}`,
        {
          query: { sysparm_fields: fields?.length ? fields.join(',') : undefined },
        },
      );
      const ok = await ensureOk(res);
      const body = (await ok.json()) as { result?: unknown };
      return body.result as Record<string, unknown>;
    },
  };
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/servicenow/table-api.test.ts`
Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/servicenow/table-api.ts src/servicenow/table-api.test.ts
git commit -m "feat: ServiceNow Table API wrapper (query + getRecord)"
```

---

## Task 7: Aggregate API wrapper

**Files:**

- Create: `src/servicenow/aggregate-api.ts`
- Create: `src/servicenow/aggregate-api.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/servicenow/aggregate-api.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createAggregateApi } from './aggregate-api.js';
import type { HttpClient } from '../http/client.js';

function mockClient(body: unknown): {
  client: HttpClient;
  calls: Array<{ path: string; query?: Record<string, string | undefined> }>;
} {
  const calls: Array<{ path: string; query?: Record<string, string | undefined> }> = [];
  const client: HttpClient = {
    request: vi.fn(async (path: string, opts) => {
      calls.push({ path, query: opts?.query });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
    requestRaw: vi.fn(),
  };
  return { client, calls };
}

describe('AggregateApi.aggregate', () => {
  it('GETs /api/now/stats/<table> with count when operation=count', async () => {
    const { client, calls } = mockClient({ result: [{ stats: { count: '42' } }] });
    const api = createAggregateApi(client);
    const out = await api.aggregate('incident', { operation: 'count' });
    expect(calls[0]?.path).toBe('/api/now/stats/incident');
    expect(calls[0]?.query?.sysparm_count).toBe('true');
    expect(out).toEqual([{ group: {}, value: 42 }]);
  });

  it('passes sysparm_group_by and sysparm_avg_fields when operation=avg with grouping', async () => {
    const { client, calls } = mockClient({
      result: [
        {
          groupby_fields: [{ field: 'priority', value: '1' }],
          stats: { avg: { duration: '120' } },
        },
        {
          groupby_fields: [{ field: 'priority', value: '2' }],
          stats: { avg: { duration: '200' } },
        },
      ],
    });
    const api = createAggregateApi(client);
    const out = await api.aggregate('incident', {
      operation: 'avg',
      field: 'duration',
      groupBy: ['priority'],
      sysparmQuery: 'active=true',
    });
    expect(calls[0]?.query?.sysparm_group_by).toBe('priority');
    expect(calls[0]?.query?.sysparm_avg_fields).toBe('duration');
    expect(calls[0]?.query?.sysparm_query).toBe('active=true');
    expect(out).toEqual([
      { group: { priority: '1' }, value: 120 },
      { group: { priority: '2' }, value: 200 },
    ]);
  });

  it('throws when a non-count operation is missing a field', async () => {
    const { client } = mockClient({ result: [] });
    const api = createAggregateApi(client);
    await expect(api.aggregate('incident', { operation: 'sum' })).rejects.toThrow(/field/);
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/servicenow/aggregate-api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/servicenow/aggregate-api.ts`**

```ts
import type { HttpClient } from '../http/client.js';
import { ensureOk } from '../http/translate-error.js';

export type AggregateOperation = 'count' | 'avg' | 'sum' | 'min' | 'max';

export interface AggregateOptions {
  operation: AggregateOperation;
  field?: string;
  groupBy?: string[];
  sysparmQuery?: string;
}

export interface AggregateResult {
  group: Record<string, string>;
  value: number;
}

export interface AggregateApi {
  aggregate(table: string, opts: AggregateOptions): Promise<AggregateResult[]>;
}

export function createAggregateApi(http: HttpClient): AggregateApi {
  return {
    async aggregate(table, opts) {
      if (opts.operation !== 'count' && !opts.field) {
        throw new Error(`aggregate operation "${opts.operation}" requires a field`);
      }
      const query: Record<string, string | undefined> = {
        sysparm_query: opts.sysparmQuery,
        sysparm_group_by: opts.groupBy?.length ? opts.groupBy.join(',') : undefined,
      };
      switch (opts.operation) {
        case 'count':
          query.sysparm_count = 'true';
          break;
        case 'avg':
          query.sysparm_avg_fields = opts.field;
          break;
        case 'sum':
          query.sysparm_sum_fields = opts.field;
          break;
        case 'min':
          query.sysparm_min_fields = opts.field;
          break;
        case 'max':
          query.sysparm_max_fields = opts.field;
          break;
      }
      const res = await http.request(`/api/now/stats/${encodeURIComponent(table)}`, { query });
      const ok = await ensureOk(res);
      const body = (await ok.json()) as {
        result?: Array<{
          groupby_fields?: Array<{ field: string; value: string }>;
          stats?: Record<string, unknown>;
        }>;
      };
      const rows = body.result ?? [];
      return rows.map((row) => ({
        group: Object.fromEntries((row.groupby_fields ?? []).map((g) => [g.field, g.value])),
        value: extractStat(row.stats ?? {}, opts),
      }));
    },
  };
}

function extractStat(stats: Record<string, unknown>, opts: AggregateOptions): number {
  if (opts.operation === 'count') {
    return Number(stats.count ?? 0);
  }
  const bucket = stats[opts.operation] as Record<string, unknown> | undefined;
  if (!bucket || !opts.field) return NaN;
  return Number(bucket[opts.field] ?? NaN);
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/servicenow/aggregate-api.test.ts`
Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/servicenow/aggregate-api.ts src/servicenow/aggregate-api.test.ts
git commit -m "feat: ServiceNow Aggregate (stats) API wrapper"
```

---

## Task 8: Attachment API wrapper

**Files:**

- Create: `src/servicenow/attachment-api.ts`
- Create: `src/servicenow/attachment-api.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/servicenow/attachment-api.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createAttachmentApi } from './attachment-api.js';
import type { HttpClient } from '../http/client.js';

describe('AttachmentApi.getAttachment', () => {
  it('fetches metadata then file content', async () => {
    const calls: string[] = [];
    const client: HttpClient = {
      request: vi.fn(async (path: string) => {
        calls.push(path);
        if (path.endsWith('/file')) {
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          });
        }
        return new Response(
          JSON.stringify({
            result: {
              sys_id: 'att1',
              file_name: 'hello.txt',
              content_type: 'text/plain',
              size_bytes: '4',
              table_name: 'incident',
              table_sys_id: 'inc1',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
      requestRaw: vi.fn(),
    };
    const api = createAttachmentApi(client);
    const out = await api.getAttachment('att1');
    expect(calls).toEqual(['/api/now/attachment/att1', '/api/now/attachment/att1/file']);
    expect(out.metadata).toEqual({
      name: 'hello.txt',
      content_type: 'text/plain',
      size_bytes: 4,
      table: 'incident',
      record_sys_id: 'inc1',
    });
    expect(Buffer.from(out.content_base64, 'base64')).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('throws when metadata returns 404', async () => {
    const client: HttpClient = {
      request: vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'gone' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
      ),
      requestRaw: vi.fn(),
    };
    const api = createAttachmentApi(client);
    await expect(api.getAttachment('nope')).rejects.toThrow(/404/);
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/servicenow/attachment-api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/servicenow/attachment-api.ts`**

```ts
import type { HttpClient } from '../http/client.js';
import { ensureOk } from '../http/translate-error.js';

export interface AttachmentMetadata {
  name: string;
  content_type: string;
  size_bytes: number;
  table: string;
  record_sys_id: string;
}

export interface Attachment {
  metadata: AttachmentMetadata;
  content_base64: string;
}

export interface AttachmentApi {
  getAttachment(sysId: string): Promise<Attachment>;
}

export function createAttachmentApi(http: HttpClient): AttachmentApi {
  return {
    async getAttachment(sysId) {
      const metaRes = await http.request(`/api/now/attachment/${encodeURIComponent(sysId)}`);
      const metaOk = await ensureOk(metaRes);
      const metaBody = (await metaOk.json()) as { result: Record<string, string> };
      const r = metaBody.result;
      const metadata: AttachmentMetadata = {
        name: r.file_name ?? '',
        content_type: r.content_type ?? 'application/octet-stream',
        size_bytes: Number(r.size_bytes ?? 0),
        table: r.table_name ?? '',
        record_sys_id: r.table_sys_id ?? '',
      };
      const fileRes = await http.request(`/api/now/attachment/${encodeURIComponent(sysId)}/file`);
      const fileOk = await ensureOk(fileRes);
      const bytes = new Uint8Array(await fileOk.arrayBuffer());
      return { metadata, content_base64: Buffer.from(bytes).toString('base64') };
    },
  };
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/servicenow/attachment-api.test.ts`
Expected: 2 tests passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/servicenow/attachment-api.ts src/servicenow/attachment-api.test.ts
git commit -m "feat: ServiceNow Attachment API wrapper"
```

---

## Task 9: Report API wrapper

**Files:**

- Create: `src/servicenow/report-api.ts`
- Create: `src/servicenow/report-api.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/servicenow/report-api.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createReportApi } from './report-api.js';
import type { TableApi } from './table-api.js';

function fakeTableApi(records: Record<string, unknown>): TableApi {
  return {
    query: vi.fn(async (table: string, opts) => ({
      records: (records[table] as Record<string, unknown>[]) ?? [],
      total: (records[table] as unknown[])?.length,
    })),
    getRecord: vi.fn(async (table: string, sysId: string) => {
      const arr = records[table] as Record<string, unknown>[];
      return arr.find((r) => r.sys_id === sysId) as Record<string, unknown>;
    }),
  };
}

describe('ReportApi.runSavedReport', () => {
  it('loads a list-type report, derives the query, and executes via TableApi', async () => {
    const tableApi = fakeTableApi({
      sys_report: [
        {
          sys_id: 'rep1',
          type: 'list',
          table: 'incident',
          filter: 'priority=1',
          field_list: 'number,short_description',
        },
      ],
      incident: [
        { sys_id: 'i1', number: 'INC1' },
        { sys_id: 'i2', number: 'INC2' },
      ],
    });
    const api = createReportApi(tableApi);
    const out = await api.runSavedReport('rep1', { limit: 25, offset: 0 });
    expect(out.definition).toEqual({ table: 'incident', columns: ['number', 'short_description'] });
    expect(out.records).toHaveLength(2);
    expect(tableApi.query).toHaveBeenCalledWith(
      'incident',
      expect.objectContaining({
        sysparmQuery: 'priority=1',
        fields: ['number', 'short_description'],
        limit: 25,
        offset: 0,
      }),
    );
  });

  it('returns unsupported_report_type error for non-list reports', async () => {
    const tableApi = fakeTableApi({
      sys_report: [{ sys_id: 'rep2', type: 'pie', table: 'incident', filter: '' }],
    });
    const api = createReportApi(tableApi);
    await expect(api.runSavedReport('rep2', {})).rejects.toThrow(/unsupported_report_type/);
  });

  it('throws when the report sys_id does not exist', async () => {
    const tableApi: TableApi = {
      query: vi.fn(async () => ({ records: [], total: 0 })),
      getRecord: vi.fn(async () => {
        throw new Error('404 not found');
      }),
    };
    const api = createReportApi(tableApi);
    await expect(api.runSavedReport('missing', {})).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/servicenow/report-api.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/servicenow/report-api.ts`**

```ts
import type { TableApi, QueryResult } from './table-api.js';

export interface ReportRunOptions {
  limit?: number;
  offset?: number;
}

export interface ReportRunResult {
  records: Record<string, unknown>[];
  total?: number;
  next_offset?: number;
  definition: { table: string; columns: string[] };
}

export interface ReportApi {
  runSavedReport(reportSysId: string, opts: ReportRunOptions): Promise<ReportRunResult>;
}

export function createReportApi(tableApi: TableApi): ReportApi {
  return {
    async runSavedReport(reportSysId, opts) {
      const report = (await tableApi.getRecord('sys_report', reportSysId, [
        'type',
        'table',
        'filter',
        'field_list',
      ])) as {
        type?: string;
        table?: string;
        filter?: string;
        field_list?: string;
      };
      if (report.type !== 'list') {
        throw new Error(`unsupported_report_type: ${report.type ?? 'unknown'}`);
      }
      const columns = (report.field_list ?? '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      const result: QueryResult = await tableApi.query(report.table ?? '', {
        sysparmQuery: report.filter ?? undefined,
        fields: columns.length ? columns : undefined,
        limit: opts.limit ?? 25,
        offset: opts.offset ?? 0,
      });
      return {
        records: result.records as Record<string, unknown>[],
        total: result.total,
        next_offset: result.next_offset,
        definition: { table: report.table ?? '', columns },
      };
    },
  };
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/servicenow/report-api.test.ts`
Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/servicenow/report-api.ts src/servicenow/report-api.test.ts
git commit -m "feat: read and execute saved list-type reports"
```

---

## Task 10: User context wrapper

**Files:**

- Create: `src/servicenow/user-context.ts`
- Create: `src/servicenow/user-context.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/servicenow/user-context.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createUserContextApi } from './user-context.js';
import type { TableApi } from './table-api.js';

describe('UserContextApi.getUserContext', () => {
  it('resolves user, roles, and groups for the authenticated user', async () => {
    const tableApi: TableApi = {
      query: vi.fn(async (table: string, _opts) => {
        if (table === 'sys_user') {
          return {
            records: [
              { sys_id: 'u1', user_name: 'jagaitera', name: 'Jomariel Gaitera', email: 'j@x' },
            ],
            total: 1,
          };
        }
        if (table === 'sys_user_has_role') {
          return {
            records: [
              { role: { value: 'r1', display_value: 'admin' } },
              { role: { value: 'r2', display_value: 'itil' } },
            ],
            total: 2,
          };
        }
        if (table === 'sys_user_grmember') {
          return {
            records: [{ group: { value: 'g1', display_value: 'Network' } }],
            total: 1,
          };
        }
        return { records: [], total: 0 };
      }),
      getRecord: vi.fn(),
    };
    const api = createUserContextApi(tableApi);
    const out = await api.getUserContext();
    expect(out).toEqual({
      sys_id: 'u1',
      user_name: 'jagaitera',
      name: 'Jomariel Gaitera',
      email: 'j@x',
      roles: ['admin', 'itil'],
      groups: ['Network'],
    });
    expect(tableApi.query).toHaveBeenCalledWith(
      'sys_user',
      expect.objectContaining({
        sysparmQuery: 'user_name=javascript:gs.getUser().getName()',
      }),
    );
  });

  it('throws when sys_user lookup returns no rows', async () => {
    const tableApi: TableApi = {
      query: vi.fn(async () => ({ records: [], total: 0 })),
      getRecord: vi.fn(),
    };
    const api = createUserContextApi(tableApi);
    await expect(api.getUserContext()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/servicenow/user-context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/servicenow/user-context.ts`**

```ts
import type { TableApi } from './table-api.js';

export interface UserContext {
  sys_id: string;
  user_name: string;
  name: string;
  email: string;
  roles: string[];
  groups: string[];
}

export interface UserContextApi {
  getUserContext(): Promise<UserContext>;
}

export function createUserContextApi(tableApi: TableApi): UserContextApi {
  return {
    async getUserContext() {
      const userQ = await tableApi.query('sys_user', {
        sysparmQuery: 'user_name=javascript:gs.getUser().getName()',
        fields: ['sys_id', 'user_name', 'name', 'email'],
        limit: 1,
        displayValue: 'false',
      });
      const u = userQ.records[0];
      if (!u) {
        throw new Error('authenticated user not found in sys_user');
      }
      const userSysId = String(u.sys_id);
      const [rolesQ, groupsQ] = await Promise.all([
        tableApi.query('sys_user_has_role', {
          sysparmQuery: `user=${userSysId}`,
          fields: ['role'],
          limit: 1000,
          displayValue: 'all',
        }),
        tableApi.query('sys_user_grmember', {
          sysparmQuery: `user=${userSysId}`,
          fields: ['group'],
          limit: 1000,
          displayValue: 'all',
        }),
      ]);
      const roles = rolesQ.records
        .map((r) => (r.role as { display_value?: string } | undefined)?.display_value)
        .filter((s): s is string => Boolean(s));
      const groups = groupsQ.records
        .map((r) => (r.group as { display_value?: string } | undefined)?.display_value)
        .filter((s): s is string => Boolean(s));
      return {
        sys_id: userSysId,
        user_name: String(u.user_name ?? ''),
        name: String(u.name ?? ''),
        email: String(u.email ?? ''),
        roles,
        groups,
      };
    },
  };
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/servicenow/user-context.test.ts`
Expected: 2 tests passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/servicenow/user-context.ts src/servicenow/user-context.test.ts
git commit -m "feat: resolve authenticated user roles and groups"
```

---

## Task 11: ServiceNowClient composition root

**Files:**

- Create: `src/servicenow/client.ts`
- Create: `src/servicenow/client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/servicenow/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createServiceNowClient } from './client.js';
import type { ServerConfig } from '../config.js';

const cfg: ServerConfig = {
  instanceUrl: 'https://example.service-now.com',
  auth: { kind: 'bearer', token: 't' },
};

describe('createServiceNowClient', () => {
  it('exposes table, aggregate, attachment, report, and userContext APIs', () => {
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    const client = createServiceNowClient(cfg, fetchImpl);
    expect(typeof client.table.query).toBe('function');
    expect(typeof client.table.getRecord).toBe('function');
    expect(typeof client.aggregate.aggregate).toBe('function');
    expect(typeof client.attachment.getAttachment).toBe('function');
    expect(typeof client.report.runSavedReport).toBe('function');
    expect(typeof client.userContext.getUserContext).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/servicenow/client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/servicenow/client.ts`**

```ts
import type { ServerConfig } from '../config.js';
import { createHttpClient } from '../http/client.js';
import { withRetry } from '../http/retry.js';
import type { HttpClient, RequestOptions } from '../http/client.js';
import { createTableApi, type TableApi } from './table-api.js';
import { createAggregateApi, type AggregateApi } from './aggregate-api.js';
import { createAttachmentApi, type AttachmentApi } from './attachment-api.js';
import { createReportApi, type ReportApi } from './report-api.js';
import { createUserContextApi, type UserContextApi } from './user-context.js';

export interface ServiceNowClient {
  table: TableApi;
  aggregate: AggregateApi;
  attachment: AttachmentApi;
  report: ReportApi;
  userContext: UserContextApi;
}

export function createServiceNowClient(
  config: ServerConfig,
  fetchImpl: typeof fetch = fetch,
): ServiceNowClient {
  const base = createHttpClient(config, fetchImpl);
  const http: HttpClient = {
    request: (path: string, opts?: RequestOptions) => withRetry(() => base.request(path, opts)),
    requestRaw: (method, path, opts) => withRetry(() => base.requestRaw(method, path, opts)),
  };
  const table = createTableApi(http);
  return {
    table,
    aggregate: createAggregateApi(http),
    attachment: createAttachmentApi(http),
    report: createReportApi(table),
    userContext: createUserContextApi(table),
  };
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/servicenow/client.test.ts`
Expected: 1 test passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/servicenow/client.ts src/servicenow/client.test.ts
git commit -m "feat: ServiceNowClient composition root with retry-wrapped HTTP"
```

---

## Task 12: MCP tool helper — wrap handlers with error translation

**Files:**

- Create: `src/mcp/tool-helpers.ts`
- Create: `src/mcp/tool-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/mcp/tool-helpers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toMcpResult, runTool } from './tool-helpers.js';
import { ServiceNowAuthError, ServiceNowNotFoundError } from '../errors.js';

describe('toMcpResult', () => {
  it('wraps a successful value as a JSON content block', () => {
    const r = toMcpResult({ ok: true, n: 1 });
    expect(r).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1 }, null, 2) }],
    });
  });
});

describe('runTool', () => {
  it('returns the handler result wrapped via toMcpResult on success', async () => {
    const out = await runTool(async () => ({ hello: 'world' }));
    expect(out.isError).toBeUndefined();
    expect(out.content?.[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('hello'),
    });
  });

  it('maps ServiceNowNotFoundError to a not_found error block', async () => {
    const out = await runTool(async () => {
      throw new ServiceNowNotFoundError(404, { error: 'gone' }, 'gone');
    });
    expect(out.isError).toBe(true);
    const text = (out.content?.[0] as { text: string }).text;
    expect(text).toContain('not_found');
    expect(text).not.toContain('Bearer');
  });

  it('maps ServiceNowAuthError to an auth_error block', async () => {
    const out = await runTool(async () => {
      throw new ServiceNowAuthError(401, null, 'denied');
    });
    expect(out.isError).toBe(true);
    expect((out.content?.[0] as { text: string }).text).toContain('auth_error');
  });

  it('maps unknown errors to internal_error block without leaking stack', async () => {
    const out = await runTool(async () => {
      throw new Error('boom');
    });
    expect(out.isError).toBe(true);
    const text = (out.content?.[0] as { text: string }).text;
    expect(text).toContain('internal_error');
    expect(text).not.toContain('at ');
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/mcp/tool-helpers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/tool-helpers.ts`**

```ts
import {
  ServiceNowAuthError,
  ServiceNowClientError,
  ServiceNowNotFoundError,
  ServiceNowRateLimitError,
  ServiceNowServerError,
} from '../errors.js';
import { redact } from '../http/client.js';

export interface McpResult {
  content?: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | Record<string, unknown>
  >;
  isError?: boolean;
}

export function toMcpResult(value: unknown): McpResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export async function runTool(handler: () => Promise<unknown>): Promise<McpResult> {
  try {
    const value = await handler();
    return toMcpResult(value);
  } catch (err) {
    return toErrorResult(err);
  }
}

function toErrorResult(err: unknown): McpResult {
  if (err instanceof ServiceNowNotFoundError) return errorBlock('not_found', err.status, err.body);
  if (err instanceof ServiceNowAuthError) return errorBlock('auth_error', err.status, err.body);
  if (err instanceof ServiceNowRateLimitError)
    return errorBlock('rate_limited', err.status, err.body, { retry_after_ms: err.retryAfterMs });
  if (err instanceof ServiceNowServerError)
    return errorBlock('upstream_error', err.status, err.body);
  if (err instanceof ServiceNowClientError) return errorBlock('client_error', err.status, err.body);
  const message = err instanceof Error ? err.message : String(err);
  return errorBlock('internal_error', 0, { message });
}

function errorBlock(
  code: string,
  status: number,
  body: unknown,
  extra?: Record<string, unknown>,
): McpResult {
  const payload = { error: { code, status, body: redact(body), ...extra } };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/mcp/tool-helpers.test.ts`
Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/mcp/tool-helpers.ts src/mcp/tool-helpers.test.ts
git commit -m "feat: MCP tool helpers for result wrapping and error mapping"
```

---

## Task 13: Tool — list_tables

**Files:**

- Create: `src/mcp/tools/list-tables.ts`
- Create: `src/mcp/tools/list-tables.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/mcp/tools/list-tables.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createListTablesTool } from './list-tables.js';
import type { ServiceNowClient } from '../../servicenow/client.js';

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
    const tool = createListTablesTool(client);
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
    const tool = createListTablesTool(client);
    const out = await tool.handler({ filter: 'CHANGE' });
    const text = (out.content?.[0] as { text: string }).text;
    expect(text).toContain('change_request');
    expect(text).not.toContain('cmdb_ci');
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/mcp/tools/list-tables.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/tools/list-tables.ts`**

```ts
import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const listTablesInput = {
  filter: z
    .string()
    .optional()
    .describe('Case-insensitive substring matched against table name and label.'),
};

export interface ListTablesTool {
  name: 'list_tables';
  description: string;
  inputShape: typeof listTablesInput;
  handler(input: { filter?: string }): Promise<McpResult>;
}

export function createListTablesTool(client: ServiceNowClient): ListTablesTool {
  return {
    name: 'list_tables',
    description:
      'List ServiceNow tables visible to the authenticated user. Use the optional `filter` arg to narrow by name or label.',
    inputShape: listTablesInput,
    handler: (input) =>
      runTool(async () => {
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
        const f = input.filter?.toLowerCase();
        const rows = f
          ? out.records.filter(
              (r) => r.name?.toLowerCase().includes(f) || r.label?.toLowerCase().includes(f),
            )
          : out.records;
        return rows.map(({ name, label, super_class }) => ({ name, label, super_class }));
      }),
  };
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/mcp/tools/list-tables.test.ts`
Expected: 2 tests passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/mcp/tools/list-tables.ts src/mcp/tools/list-tables.test.ts
git commit -m "feat: list_tables MCP tool"
```

---

## Task 14: Tool — describe_table

**Files:**

- Create: `src/mcp/tools/describe-table.ts`
- Create: `src/mcp/tools/describe-table.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/mcp/tools/describe-table.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createDescribeTableTool } from './describe-table.js';
import type { ServiceNowClient } from '../../servicenow/client.js';

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
    const tool = createDescribeTableTool(client);
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
    const client = {
      table: { query: vi.fn(async () => ({ records: [], total: 0 })), getRecord: vi.fn() },
      aggregate: { aggregate: vi.fn() },
      attachment: { getAttachment: vi.fn() },
      report: { runSavedReport: vi.fn() },
      userContext: { getUserContext: vi.fn() },
    } as unknown as ServiceNowClient;
    const tool = createDescribeTableTool(client);
    const out = await tool.handler({ name: 'nope' });
    expect(out.isError).toBe(true);
    expect((out.content?.[0] as { text: string }).text).toContain('not_found');
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/mcp/tools/describe-table.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/tools/describe-table.ts`**

```ts
import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
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

export function createDescribeTableTool(client: ServiceNowClient): DescribeTableTool {
  return {
    name: 'describe_table',
    description:
      'Describe a ServiceNow table: label, parent table, and field definitions (from sys_dictionary).',
    inputShape: describeTableInput,
    handler: (input) =>
      runTool(async () => {
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
        return {
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
      }),
  };
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/mcp/tools/describe-table.test.ts`
Expected: 2 tests passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/mcp/tools/describe-table.ts src/mcp/tools/describe-table.test.ts
git commit -m "feat: describe_table MCP tool"
```

---

## Task 15: Tool — query_table

**Files:**

- Create: `src/mcp/tools/query-table.ts`
- Create: `src/mcp/tools/query-table.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/mcp/tools/query-table.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createQueryTableTool } from './query-table.js';
import type { ServiceNowClient } from '../../servicenow/client.js';

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
    const tool = createQueryTableTool(client);
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
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/mcp/tools/query-table.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/tools/query-table.ts`**

```ts
import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
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

export function createQueryTableTool(client: ServiceNowClient): QueryTableTool {
  return {
    name: 'query_table',
    description:
      'Query any ServiceNow table. Returns a page of records plus optional next_offset for pagination. Default limit is 25; large limits burn context, so request only what you need.',
    inputShape: queryTableInput,
    handler: (input) =>
      runTool(async () => {
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
        return result;
      }),
  };
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/mcp/tools/query-table.test.ts`
Expected: 1 test passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/mcp/tools/query-table.ts src/mcp/tools/query-table.test.ts
git commit -m "feat: query_table MCP tool"
```

---

## Task 16: Tool — get_record

**Files:**

- Create: `src/mcp/tools/get-record.ts`
- Create: `src/mcp/tools/get-record.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/mcp/tools/get-record.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createGetRecordTool } from './get-record.js';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { ServiceNowNotFoundError } from '../../errors.js';

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
    const tool = createGetRecordTool(client);
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
    const tool = createGetRecordTool(client);
    const out = await tool.handler({ table: 'incident', sys_id: 'missing' });
    expect(out.isError).toBe(true);
    expect((out.content?.[0] as { text: string }).text).toContain('not_found');
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/mcp/tools/get-record.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/tools/get-record.ts`**

```ts
import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
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

export function createGetRecordTool(client: ServiceNowClient): GetRecordTool {
  return {
    name: 'get_record',
    description: 'Fetch a single ServiceNow record by table and sys_id.',
    inputShape: getRecordInput,
    handler: (input) =>
      runTool(() => client.table.getRecord(input.table, input.sys_id, input.fields)),
  };
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/mcp/tools/get-record.test.ts`
Expected: 2 tests passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/mcp/tools/get-record.ts src/mcp/tools/get-record.test.ts
git commit -m "feat: get_record MCP tool"
```

---

## Task 17: Tool — get_attachment

**Files:**

- Create: `src/mcp/tools/get-attachment.ts`
- Create: `src/mcp/tools/get-attachment.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/mcp/tools/get-attachment.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createGetAttachmentTool } from './get-attachment.js';
import type { ServiceNowClient } from '../../servicenow/client.js';

describe('get_attachment tool', () => {
  it('returns metadata plus base64 content from AttachmentApi', async () => {
    const getAttachment = vi.fn(async () => ({
      metadata: {
        name: 'a.txt',
        content_type: 'text/plain',
        size_bytes: 3,
        table: 'incident',
        record_sys_id: 'i1',
      },
      content_base64: 'AAEC',
    }));
    const client = {
      table: { query: vi.fn(), getRecord: vi.fn() },
      aggregate: { aggregate: vi.fn() },
      attachment: { getAttachment },
      report: { runSavedReport: vi.fn() },
      userContext: { getUserContext: vi.fn() },
    } as unknown as ServiceNowClient;
    const tool = createGetAttachmentTool(client);
    const out = await tool.handler({ sys_id: 'att1' });
    expect(getAttachment).toHaveBeenCalledWith('att1');
    const payload = JSON.parse((out.content?.[0] as { text: string }).text);
    expect(payload.metadata.name).toBe('a.txt');
    expect(payload.content_base64).toBe('AAEC');
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/mcp/tools/get-attachment.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/tools/get-attachment.ts`**

```ts
import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const getAttachmentInput = {
  sys_id: z.string().describe('The attachment sys_id (from sys_attachment).'),
};

export interface GetAttachmentTool {
  name: 'get_attachment';
  description: string;
  inputShape: typeof getAttachmentInput;
  handler(input: { sys_id: string }): Promise<McpResult>;
}

export function createGetAttachmentTool(client: ServiceNowClient): GetAttachmentTool {
  return {
    name: 'get_attachment',
    description:
      'Download a ServiceNow attachment by sys_id. Returns metadata plus base64-encoded content.',
    inputShape: getAttachmentInput,
    handler: (input) => runTool(() => client.attachment.getAttachment(input.sys_id)),
  };
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/mcp/tools/get-attachment.test.ts`
Expected: 1 test passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/mcp/tools/get-attachment.ts src/mcp/tools/get-attachment.test.ts
git commit -m "feat: get_attachment MCP tool"
```

---

## Task 18: Tool — aggregate

**Files:**

- Create: `src/mcp/tools/aggregate.ts`
- Create: `src/mcp/tools/aggregate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/mcp/tools/aggregate.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createAggregateTool } from './aggregate.js';
import type { ServiceNowClient } from '../../servicenow/client.js';

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
    const tool = createAggregateTool(client);
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
    const tool = createAggregateTool(client);
    const out = await tool.handler({ table: 'incident', operation: 'sum' });
    expect(out.isError).toBe(true);
    expect((out.content?.[0] as { text: string }).text).toContain('internal_error');
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/mcp/tools/aggregate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/tools/aggregate.ts`**

```ts
import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
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

export function createAggregateTool(client: ServiceNowClient): AggregateTool {
  return {
    name: 'aggregate',
    description:
      'Run a ServiceNow aggregate query (count/avg/sum/min/max) optionally grouped by fields.',
    inputShape: aggregateInput,
    handler: (input) =>
      runTool(() =>
        client.aggregate.aggregate(input.table, {
          operation: input.operation,
          field: input.field,
          groupBy: input.group_by,
          sysparmQuery: input.sysparm_query,
        }),
      ),
  };
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/mcp/tools/aggregate.test.ts`
Expected: 2 tests passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/mcp/tools/aggregate.ts src/mcp/tools/aggregate.test.ts
git commit -m "feat: aggregate MCP tool"
```

---

## Task 19: Tool — run_saved_report

**Files:**

- Create: `src/mcp/tools/run-saved-report.ts`
- Create: `src/mcp/tools/run-saved-report.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/mcp/tools/run-saved-report.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createRunSavedReportTool } from './run-saved-report.js';
import type { ServiceNowClient } from '../../servicenow/client.js';

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
    const tool = createRunSavedReportTool(client);
    const out = await tool.handler({ report_sys_id: 'rep1', limit: 10, offset: 0 });
    expect(runSavedReport).toHaveBeenCalledWith('rep1', { limit: 10, offset: 0 });
    const payload = JSON.parse((out.content?.[0] as { text: string }).text);
    expect(payload.definition).toEqual({ table: 'incident', columns: ['number'] });
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/mcp/tools/run-saved-report.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/tools/run-saved-report.ts`**

```ts
import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
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

export function createRunSavedReportTool(client: ServiceNowClient): RunSavedReportTool {
  return {
    name: 'run_saved_report',
    description:
      'Execute a saved ServiceNow report (list type) by sys_id. Returns the resulting records plus the report definition.',
    inputShape: runSavedReportInput,
    handler: (input) =>
      runTool(() =>
        client.report.runSavedReport(input.report_sys_id, {
          limit: input.limit,
          offset: input.offset,
        }),
      ),
  };
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/mcp/tools/run-saved-report.test.ts`
Expected: 1 test passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/mcp/tools/run-saved-report.ts src/mcp/tools/run-saved-report.test.ts
git commit -m "feat: run_saved_report MCP tool"
```

---

## Task 20: Tool — get_user_context

**Files:**

- Create: `src/mcp/tools/get-user-context.ts`
- Create: `src/mcp/tools/get-user-context.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/mcp/tools/get-user-context.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createGetUserContextTool } from './get-user-context.js';
import type { ServiceNowClient } from '../../servicenow/client.js';

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
    const tool = createGetUserContextTool(client);
    const out = await tool.handler({});
    expect(getUserContext).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((out.content?.[0] as { text: string }).text);
    expect(payload.user_name).toBe('jagaitera');
    expect(payload.roles).toEqual(['admin']);
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/mcp/tools/get-user-context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/tools/get-user-context.ts`**

```ts
import type { ServiceNowClient } from '../../servicenow/client.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const getUserContextInput = {} as const;

export interface GetUserContextTool {
  name: 'get_user_context';
  description: string;
  inputShape: typeof getUserContextInput;
  handler(input: Record<string, never>): Promise<McpResult>;
}

export function createGetUserContextTool(client: ServiceNowClient): GetUserContextTool {
  return {
    name: 'get_user_context',
    description:
      'Return the authenticated user (user_name, sys_id, name, email) plus their roles and groups.',
    inputShape: getUserContextInput,
    handler: () => runTool(() => client.userContext.getUserContext()),
  };
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/mcp/tools/get-user-context.test.ts`
Expected: 1 test passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/mcp/tools/get-user-context.ts src/mcp/tools/get-user-context.test.ts
git commit -m "feat: get_user_context MCP tool"
```

---

## Task 21: Resource — `servicenow://tables`

**Files:**

- Create: `src/mcp/resources/tables.ts`
- Create: `src/mcp/resources/tables.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/mcp/resources/tables.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createTablesResource } from './tables.js';
import type { ServiceNowClient } from '../../servicenow/client.js';

describe('tables resource', () => {
  it('returns ServiceNow tables as a JSON resource', async () => {
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
    const resource = createTablesResource(client);
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
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/mcp/resources/tables.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/resources/tables.ts`**

```ts
import type { ServiceNowClient } from '../../servicenow/client.js';

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

export function createTablesResource(client: ServiceNowClient): TablesResource {
  return {
    uri: 'servicenow://tables',
    name: 'tables',
    description: 'Live catalog of ServiceNow tables visible to the authenticated user.',
    mimeType: 'application/json',
    async read() {
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
      return {
        contents: [{ uri: 'servicenow://tables', mimeType: 'application/json', text }],
      };
    },
  };
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/mcp/resources/tables.test.ts`
Expected: 1 test passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/mcp/resources/tables.ts src/mcp/resources/tables.test.ts
git commit -m "feat: servicenow://tables MCP resource"
```

---

## Task 22: McpServer composition

**Files:**

- Create: `src/mcp/server.ts`
- Create: `src/mcp/server.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/mcp/server.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createMcpServer } from './server.js';
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

describe('createMcpServer', () => {
  it('registers the 8 tools and the tables resource', () => {
    const server = createMcpServer(fakeClient());
    // McpServer exposes lower-level Server via .server. We just confirm it built.
    expect(server.server).toBeDefined();
    // Indirect check: introspect registered tools via the internal map (test-only access).
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(tools).sort()).toEqual(
      [
        'aggregate',
        'describe_table',
        'get_attachment',
        'get_record',
        'get_user_context',
        'list_tables',
        'query_table',
        'run_saved_report',
      ].sort(),
    );
    const resources = (server as unknown as { _registeredResources: Record<string, unknown> })
      ._registeredResources;
    expect(Object.keys(resources)).toContain('tables');
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/mcp/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/server.ts`**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServiceNowClient } from '../servicenow/client.js';
import { createListTablesTool } from './tools/list-tables.js';
import { createDescribeTableTool } from './tools/describe-table.js';
import { createQueryTableTool } from './tools/query-table.js';
import { createGetRecordTool } from './tools/get-record.js';
import { createGetAttachmentTool } from './tools/get-attachment.js';
import { createAggregateTool } from './tools/aggregate.js';
import { createRunSavedReportTool } from './tools/run-saved-report.js';
import { createGetUserContextTool } from './tools/get-user-context.js';
import { createTablesResource } from './resources/tables.js';

export function createMcpServer(client: ServiceNowClient): McpServer {
  const server = new McpServer({ name: 'snow-mcp', version: '1.0.0' });

  for (const tool of [
    createListTablesTool(client),
    createDescribeTableTool(client),
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
      (args: Record<string, unknown>) => tool.handler(args as never),
    );
  }

  const tables = createTablesResource(client);
  server.registerResource(
    tables.name,
    tables.uri,
    { description: tables.description, mimeType: tables.mimeType },
    () => tables.read(),
  );

  return server;
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/mcp/server.test.ts`
Expected: 1 test passing.

- [ ] **Step 5: Commit**

```bash
yarn typecheck && yarn lint
git add src/mcp/server.ts src/mcp/server.test.ts
git commit -m "feat: McpServer registers all snow-mcp tools and resources"
```

---

## Task 23: main.ts boot + end-to-end smoke test

**Files:**

- Modify: `src/main.ts`
- Create: `src/main.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildServer } from './main.js';

describe('buildServer', () => {
  it('throws ConfigError when env is empty', () => {
    expect(() => buildServer({})).toThrow(/Missing required configuration/);
  });

  it('returns a connectable McpServer when env is valid', () => {
    const server = buildServer({
      SNOW_INSTANCE_URL: 'https://example.service-now.com',
      SNOW_OAUTH_TOKEN: 't',
    });
    expect(server.server).toBeDefined();
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(tools)).toHaveLength(8);
  });
});
```

- [ ] **Step 2: Run test to confirm RED**

Run: `yarn test src/main.test.ts`
Expected: FAIL — `buildServer` not exported / file is a placeholder.

- [ ] **Step 3: Replace `src/main.ts` with the real entrypoint**

```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from './config.js';
import { createServiceNowClient } from './servicenow/client.js';
import { createMcpServer } from './mcp/server.js';

export function buildServer(env: NodeJS.ProcessEnv = process.env): McpServer {
  const config = loadConfig(env);
  const client = createServiceNowClient(config);
  return createMcpServer(client);
}

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to confirm GREEN**

Run: `yarn test src/main.test.ts`
Expected: 2 tests passing.

- [ ] **Step 5: Final full check and commit**

```bash
yarn typecheck && yarn lint && yarn test && yarn build
git add src/main.ts src/main.test.ts
git commit -m "feat: boot snow-mcp over stdio"
```

Confirm the build artifact runs without env set and fails cleanly:

```bash
node dist/main.js
```

Expected: prints `Missing required configuration: SNOW_INSTANCE_URL, ...` and exits with code 1.

---

## Acceptance check (run after Task 23)

This mirrors the spec's Acceptance Criteria section. Each item must pass:

1. `yarn build && yarn typecheck && yarn lint && yarn test` — all green.
2. `grep -rn 'fetch(' src/ | grep -v 'http/client.ts' | grep -v '.test.ts'` — returns no matches.
3. `grep -rEn "'(POST|PUT|PATCH|DELETE)'" src/ | grep -v 'http/client.ts' | grep -v '.test.ts'` — returns no matches.
4. `node dist/main.js` with no env produces a `ConfigError` listing every missing variable.
5. `SNOW_INSTANCE_URL=http://x SNOW_OAUTH_TOKEN=t node dist/main.js` exits with the https requirement error.
6. The integration test in `src/main.test.ts` confirms 8 registered tools.
7. The `http/client.test.ts` suite covers both auth header forms.
8. The `http/client.test.ts` suite includes the POST/PUT/PATCH/DELETE rejection test.
9. The `http/client.test.ts` redaction test asserts no `SNOW_PASSWORD`/`SNOW_OAUTH_TOKEN` value appears in serialized output.

Once all nine pass, hand off to `superpowers:finishing-a-development-branch`.
