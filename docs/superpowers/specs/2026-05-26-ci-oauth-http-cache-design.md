# snow-mcp v1.1 — CI, Schema Cache, OAuth + Streamable HTTP

**Status:** approved
**Date:** 2026-05-26
**Scope:** three sequential feature branches landing on top of v1.0.0

## Goals

Lift snow-mcp from a hand-tested, stdio-only, basic-auth-only server into something with automated quality gates, lower-latency schema reads, and the auth + transport options needed for hosted MCP clients — without breaking the read-only contract.

## Non-goals

- No ServiceNow write operations (still read-only).
- No OAuth flows other than `client_credentials`.
- No SSE transport. No disk-backed cache. No npm publish (separate follow-up).

## Branch order

1. `feat/ci` — lands first so the next two ship through it.
2. `feat/schema-cache` — small, self-contained, easy to verify.
3. `feat/oauth-and-http` — largest surface change; benefits from CI being green.

Each branch must pass `yarn typecheck`, `yarn lint`, and `yarn test` before merge.

---

## 1. CI workflow

**Branch:** `feat/ci`

### Deliverable

`.github/workflows/ci.yml`:

- Triggers: `push` to any branch, `pull_request` against any branch.
- Single job, `runs-on: ubuntu-latest`.
- Steps:
  1. `actions/checkout@v4`
  2. `actions/setup-node@v4` with `node-version: 24` and `cache: yarn`.
  3. `yarn install --frozen-lockfile`
  4. `yarn typecheck`
  5. `yarn lint`
  6. `yarn test`

### Out of scope

- No matrix across Node versions or OSes.
- No CodeQL, dependency review, or release automation.
- No deploy or publish steps.

---

## 2. Schema cache

**Branch:** `feat/schema-cache`

### Why

`describe_table` and `list_tables` resolve through `sys_dictionary` queries that are noticeably slow on real instances. The values change rarely (only on schema customizations), so a short TTL is safe and high-value.

### Module: `src/servicenow/schema-cache.ts`

A minimal generic cache:

```ts
export interface SchemaCacheOptions {
  ttlMs: number; // 0 disables the cache
  maxEntries: number; // bound to prevent unbounded growth
}

export interface SchemaCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  clear(): void;
}
```

- Backing store: `Map<string, { value: T; expiresAt: number }>`.
- Eviction: when `size >= maxEntries`, drop the oldest inserted entry (Map preserves insertion order — no LRU bookkeeping needed for v1).
- TTL: entries past `expiresAt` are treated as misses and removed on access.
- `ttlMs === 0`: `get` always returns `undefined`, `set` is a no-op. This is the kill-switch path.

### Wiring

In `src/servicenow/table-api.ts`:

- One cache instance for `describeTable` results, keyed by `tableName`.
- One cache instance for `listTables` results, keyed by a single literal `"__all__"` (the list is global).
- Cache is constructed at module init from config; tests can inject their own.

### Config (`src/config.ts`)

- `SCHEMA_CACHE_TTL_MS`: integer ≥ 0, default `300000` (5 minutes).
- `SCHEMA_CACHE_MAX_ENTRIES`: integer ≥ 1, default `256`.
- Both Zod-validated; invalid values fail fast at startup.

### Tests (`src/servicenow/schema-cache.test.ts` + updates to `table-api.test.ts`)

- Hit returns cached value without calling the HTTP layer.
- Miss after expiry triggers a fresh fetch.
- Eviction drops oldest entry when full.
- `ttlMs: 0` disables caching end-to-end.
- `table-api` integration: second `describeTable` call with same name doesn't re-hit the HTTP boundary.

---

## 3. OAuth + Streamable HTTP transport

**Branch:** `feat/oauth-and-http`

### 3a. Auth providers

New directory `src/servicenow/auth/`:

```
auth/
  auth-provider.ts          # interface
  basic-auth-provider.ts
  oauth-client-credentials-provider.ts
  index.ts                  # createAuthProvider(config)
```

#### Interface

```ts
export interface AuthProvider {
  getAuthHeader(): Promise<string>; // returns the full header value
  onUnauthorized(): Promise<void>; // hook for 401 → refresh
}
```

#### `BasicAuthProvider`

- Returns `Basic ${base64(user:password)}` synchronously.
- `onUnauthorized` is a no-op (basic auth doesn't refresh).
- Behavior identical to today's inline header construction — this is a pure refactor.

#### `OAuthClientCredentialsProvider`

- Reads `SNOW_OAUTH_CLIENT_ID`, `SNOW_OAUTH_CLIENT_SECRET`, `SNOW_INSTANCE_URL`.
- Token endpoint: `${instanceUrl}/oauth_token.do`.
- Request: `grant_type=client_credentials`, `client_id=...`, `client_secret=...` as `application/x-www-form-urlencoded`.
- Caches `access_token` in memory with an absolute expiry of `now + (expires_in - 30) * 1000` ms.
- `getAuthHeader()`:
  - If cached and not expired, return `Bearer <token>`.
  - Otherwise fetch a new token, cache it, return `Bearer <token>`.
- `onUnauthorized()`: invalidate the cached token; next `getAuthHeader()` will re-fetch.
- Errors from the token endpoint surface through the existing `translate-error` path.

#### HTTP client integration

`src/http/client.ts` becomes auth-provider-aware:

- Calls `getAuthHeader()` before each request.
- On HTTP 401, calls `onUnauthorized()` and retries the request **once**.
- The single retry is scoped to 401 only — does not stack with existing 5xx retry logic.

### 3b. Streamable HTTP transport

New directory `src/mcp/transport/`:

```
transport/
  stdio.ts        # wraps current StdioServerTransport setup
  http.ts         # wraps StreamableHTTPServerTransport
  index.ts        # createTransport(config) → Transport
```

- `stdio.ts` is a refactor — no behavior change.
- `http.ts` constructs `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk`, binds to `MCP_HTTP_HOST:MCP_HTTP_PORT`, and starts listening when the server connects.
- `main.ts` picks the transport from `MCP_TRANSPORT` and connects the existing `McpServer`. Nothing else in `main.ts` changes.

### Config additions (`src/config.ts`)

| Var                        | Type                 | Default       | Notes                                    |
| -------------------------- | -------------------- | ------------- | ---------------------------------------- |
| `SNOW_AUTH`                | `"basic" \| "oauth"` | `"basic"`     | Selects auth provider.                   |
| `SNOW_OAUTH_CLIENT_ID`     | string               | —             | Required when `SNOW_AUTH=oauth`.         |
| `SNOW_OAUTH_CLIENT_SECRET` | string               | —             | Required when `SNOW_AUTH=oauth`.         |
| `MCP_TRANSPORT`            | `"stdio" \| "http"`  | `"stdio"`     | Selects MCP transport.                   |
| `MCP_HTTP_PORT`            | integer 1–65535      | `3000`        | Used when `MCP_TRANSPORT=http`.          |
| `MCP_HTTP_HOST`            | string               | `"127.0.0.1"` | Bind address. Localhost-only by default. |

All Zod-validated. Conditional requirement (`oauth` ⇒ id+secret present) enforced via `superRefine` and fails fast at startup with a clear message.

### Tests

- `auth/basic-auth-provider.test.ts`: header value is correct base64; `onUnauthorized` is a no-op.
- `auth/oauth-client-credentials-provider.test.ts`: first call fetches token; second call within TTL is cached; `onUnauthorized` forces refresh; token-endpoint failure surfaces as a translated error.
- `http/client.test.ts`: existing tests still pass; new test asserts 401 triggers exactly one retry through the provider.
- `mcp/transport/http.test.ts`: spin up the HTTP transport on an ephemeral port, connect an in-process MCP client, invoke `list_tables`, expect a normal response.
- `config.test.ts`: missing OAuth credentials with `SNOW_AUTH=oauth` rejects at parse time.

---

## Shared

- README gets short "Auth" and "Transport" subsections in each respective branch — env vars, defaults, one example each.
- `.env.example` (new file) lists every recognized env var with placeholder values and a comment per var. `.env` stays gitignored.
- No changes to existing tool schemas. The MCP API surface is unchanged from a client's perspective.

## Risks and mitigations

- **Risk:** OAuth token endpoint differs across ServiceNow versions. **Mitigation:** stay on the documented `oauth_token.do` path; surface any non-2xx as a translated error so users see the underlying ServiceNow message.
- **Risk:** HTTP transport binds to a public interface by accident. **Mitigation:** default `MCP_HTTP_HOST=127.0.0.1`; README calls out the change required to expose it.
- **Risk:** Schema cache returns stale data after a ServiceNow customization. **Mitigation:** 5-minute default TTL; `SCHEMA_CACHE_TTL_MS=0` disables; documented in README.

## Out of scope (explicit)

- npm publish, `bin` entry, release workflow.
- Auth code / PKCE flow.
- SSE transport.
- Disk-backed cache or cross-process cache.
- Any write/mutation tools.
