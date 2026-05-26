# snow-mcp — Read-only ServiceNow MCP Server

**Status:** Approved 2026-05-26
**Owner:** Jomariel Gaitera
**Repo:** `/home/master/mcp/snow-mcp`

## Goal

Expose a ServiceNow instance to MCP clients as a **strictly read-only** data source. The client (and the LLM behind it) can discover and read records, configurations, schema, attachments, reports, and the authenticated user's context — but cannot create, update, or delete anything.

## Scope

### In scope (v1)

- Schema discovery: list/describe any table the authenticated user can read.
- Record reads: filtered queries, single-record fetch, aggregates.
- Attachment downloads (binary content returned base64-encoded).
- Saved report execution (read-only).
- Authenticated user context (roles, groups).
- Live table catalog exposed as an MCP resource.
- Auth via Basic (user/password) **or** OAuth bearer token, auto-selected from `.env`.
- stdio MCP transport only.

### Out of scope (v1)

- Any HTTP method other than `GET`.
- Write APIs (Table POST/PUT/PATCH/DELETE, Import Sets, Attachment upload, Workflow execution, Catalog request submission, etc.).
- HTTP MCP transport.
- Full OAuth client-credentials flow with token refresh (use a pre-obtained token instead).
- Caching layer.
- Multi-instance / multi-tenant support.

## Non-Functional Requirements

- **Safety**: It must be impossible — through normal use, refactors, or LLM-generated extensions — for this server to mutate ServiceNow state. Enforced at two layers (typed API + runtime guard) and verified by tests.
- **Secrets hygiene**: Credentials read only via `process.env`. Never logged, never echoed in errors. Redaction applied to `Authorization` headers and any `SNOW_*` env value before any log/serialization.
- **Startup fast-fail**: Missing or invalid config (`SNOW_INSTANCE_URL`, no auth credentials, non-`https://` URL) throws clearly at boot. No silent fallback.
- **Token economy**: Tool descriptions warn the LLM that large `limit` values consume its own context. No hard ceiling per the user's preference; default is conservative (25).

## Architecture

Single Node 24 process. ESM. TypeScript strict. stdio transport via `@modelcontextprotocol/sdk`.

```
.env
  └─> config.ts (validate, throw fast)
        └─> http/client.ts (fetch wrapper)
              ├─ GET-only (typed + runtime guard)
              ├─ injects auth (Basic or Bearer)
              ├─ retries 5xx / 429 with exp backoff + jitter (http/retry.ts)
              └─> servicenow/*-api.ts (typed wrappers per endpoint family)
                    └─> mcp/tools/*  and  mcp/resources/*
                          └─> mcp/server.ts (registers all tools/resources)
                                └─> main.ts (boot, connect StdioServerTransport)
```

### Module layout

```
src/
  config.ts                        # load + validate env, pick auth strategy
  errors.ts                        # typed error classes
  http/
    client.ts                      # GET-only fetch wrapper, auth injection, redaction
    retry.ts                       # exp backoff + jitter, Retry-After aware
  servicenow/
    client.ts                      # ServiceNowClient (composition root)
    table-api.ts                   # /api/now/table/*
    aggregate-api.ts               # /api/now/stats/*
    attachment-api.ts              # /api/now/attachment/*
    report-api.ts                  # saved report execution
    user-context.ts                # who-am-I via /api/now/table/sys_user + roles/groups
  mcp/
    server.ts                      # registers tools + resources
    tools/
      list-tables.ts
      describe-table.ts
      query-table.ts
      get-record.ts
      get-attachment.ts
      aggregate.ts
      run-saved-report.ts
      get-user-context.ts
    resources/
      tables.ts                    # servicenow://tables
  main.ts                          # boot
```

### Key invariants

1. **The HTTP guard lives in `http/client.ts` only.** No other file calls `fetch`. Enforced by ESLint `no-restricted-globals` on `fetch` (with `http/client.ts` allowlisted).
2. **Tools/resources are thin adapters.** They translate MCP input → `ServiceNowClient` method → MCP output. No URL construction, no business logic.
3. **`ServiceNowClient` is the only thing that knows the ServiceNow REST shape.**

## MCP Surface

### Resource — `servicenow://tables`

Live catalog of accessible tables. Backed by a `query_table` call against `sys_db_object` with `fields=['name', 'label', 'super_class', 'sys_id']` and no `sysparm_query` filter — return every table the authenticated user can read. Callers narrow down using the `list_tables` tool's `filter` argument when they want a subset.

**Returns:** JSON array of `{ name: string, label: string, super_class?: string, sys_id: string }`.

Refreshed on each read; no caching in v1.

### Tools (8 total)

| Tool               | Inputs                                                                                                                                                                                         | Returns                                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_tables`      | `filter?: string` (substring on name or label, case-insensitive)                                                                                                                               | `[{ name, label, super_class? }]`                                                                                                                                                  |
| `describe_table`   | `name: string`                                                                                                                                                                                 | `{ name, label, parent, fields: [{ name, label, type, reference?, mandatory, readOnly }] }` from `sys_dictionary` joined to `sys_db_object`                                        |
| `query_table`      | `table: string`, `sysparm_query?: string`, `fields?: string[]`, `limit?: number` (default 25), `offset?: number` (default 0), `display_value?: 'true' \| 'false' \| 'all'` (default `'false'`) | `{ records: object[], next_offset?: number, total?: number }`. `next_offset` present iff more results exist. `total` populated from `X-Total-Count` when ServiceNow returns it.    |
| `get_record`       | `table: string`, `sys_id: string`, `fields?: string[]`                                                                                                                                         | Record object, or `not_found` structured error                                                                                                                                     |
| `get_attachment`   | `sys_id: string`                                                                                                                                                                               | `{ metadata: { name, content_type, size_bytes, table, record_sys_id }, content_base64: string }`. Uses MCP binary content block when SDK supports it; falls back to base64 string. |
| `aggregate`        | `table: string`, `group_by?: string[]`, `operation: 'count' \| 'avg' \| 'sum' \| 'min' \| 'max'`, `field?: string` (required for non-count), `sysparm_query?: string`                          | `[{ group: Record<string, string>, value: number }]` via `/api/now/stats/{table}`                                                                                                  |
| `run_saved_report` | `report_sys_id: string`, `limit?: number`, `offset?: number`                                                                                                                                   | `{ records, next_offset?, definition: { table, columns } }`. Loads `sys_report` row, derives the query, executes via `query_table`.                                                |
| `get_user_context` | _none_                                                                                                                                                                                         | `{ user_name, sys_id, name, email, roles: string[], groups: string[] }`                                                                                                            |

Tool descriptions sent to the LLM include warnings that very large `limit` values inflate context cost.

## Cross-cutting Concerns

### Auth (in `config.ts`)

```
if process.env.SNOW_OAUTH_TOKEN          → Bearer <token>
else if SNOW_USER + SNOW_PASSWORD        → Basic base64(user:password)
else                                     → throw ConfigError listing required env vars
```

Also validates: `SNOW_INSTANCE_URL` starts with `https://`, has no trailing slash, is a parseable URL.

### HTTP guard (in `http/client.ts`)

- Exported `request(path, opts): Promise<Response>` is the primary API. No `method` parameter — always `GET` internally.
- Exported `requestRaw(method, path, opts)` exists for completeness but throws `ReadOnlyViolationError` synchronously if `method !== 'GET'`.
- Auth header injected here.
- Logging helper that scrubs `Authorization`, any `SNOW_*` value, and known credential-shaped fields before serializing request/response objects.

### Error taxonomy (in `errors.ts`)

| Class                               | When                            | Reaches LLM?                          |
| ----------------------------------- | ------------------------------- | ------------------------------------- |
| `ConfigError`                       | Bad/missing env at startup      | No — server fails to boot             |
| `ServiceNowAuthError` (401/403)     | Auth failure                    | Yes — structured error block          |
| `ServiceNowNotFoundError` (404)     | Record/table missing            | Yes — `not_found` block               |
| `ServiceNowRateLimitError` (429)    | Rate limited; retry exhausted   | Yes                                   |
| `ServiceNowServerError` (5xx)       | Upstream error; retry exhausted | Yes                                   |
| `ServiceNowClientError` (other 4xx) | Validation/permission errors    | Yes — body included after redaction   |
| `ReadOnlyViolationError`            | Internal bug: non-GET attempted | Logged loudly; should never reach LLM |

All tool-handler errors are caught in the MCP adapter layer and converted to MCP responses with `isError: true`. Stack traces, internal paths, URLs with credentials, and auth headers are stripped before leaving the process.

### Retry policy (in `http/retry.ts`)

- `5xx` and `429`: up to 3 retries, backoff `200ms`, `800ms`, `3200ms` + ±25% jitter.
- `Retry-After` header on 429 honored (overrides backoff).
- Other `4xx`: no retry.
- Network errors (`ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`): treated like `5xx`.

## Testing Strategy (Vitest)

### Unit tests (no network)

- `http/client.test.ts` — HTTP guard rejects POST/PUT/PATCH/DELETE both at the type level (compile-time check via `tsd`-style assertion) and at runtime; auth header injection (Basic and Bearer); redaction of `Authorization` and `SNOW_*` values.
- `http/retry.test.ts` — backoff timing, max attempts, `Retry-After` honored, network errors retried.
- `servicenow/*-api.test.ts` — URL construction, `sysparm_*` query string encoding, response parsing, pagination boundary cases.
- `mcp/tools/*.test.ts` — input validation, mapping of `ServiceNow*Error` to MCP `isError` responses.

### Integration tests (mocked HTTP)

- Spin up the MCP server in-process with an injected fake `HttpClient` returning canned ServiceNow JSON.
- Drive it through MCP request/response shapes end-to-end. Cover each tool happy path plus one auth-error path and one not-found path.

### Live tests (manual, opt-in)

- `INTEGRATION=1 yarn test integration/` — runs against a real dev instance, gated behind env flag. Not in CI.

### Test data

- Fixtures use obviously fake creds: `https://example.service-now.com`, `test-user`, `test-password`.
- No real ServiceNow URLs, sys_ids, or PII in committed fixtures.

## Acceptance Criteria

A reviewer should be able to verify all of the following:

1. `yarn build && yarn typecheck && yarn lint && yarn test` all pass.
2. There is no `fetch(` call anywhere in `src/` outside `http/client.ts`. ESLint enforces this.
3. The strings `'POST'`, `'PUT'`, `'PATCH'`, `'DELETE'` appear in `src/` only inside `http/client.ts` (the `requestRaw` typed signature and runtime guard). They do not appear in any other `src/` file.
4. Starting the server with none of `SNOW_INSTANCE_URL`, `SNOW_USER`, `SNOW_PASSWORD`, `SNOW_OAUTH_TOKEN` set produces a `ConfigError` whose message names every missing variable.
5. Starting with `SNOW_INSTANCE_URL=http://...` (non-HTTPS) produces a `ConfigError`.
6. The 8 tools and 1 resource are registered and discoverable via the MCP `tools/list` and `resources/list` requests.
7. With OAuth token set, requests carry `Authorization: Bearer ...`. With only Basic creds set, they carry `Authorization: Basic ...`. Tested both ways.
8. A unit test demonstrates that calling `requestRaw('POST', ...)` throws `ReadOnlyViolationError`.
9. A unit test demonstrates that error objects serialized to logs do not contain any value of `SNOW_PASSWORD` or `SNOW_OAUTH_TOKEN`.

## Risks & Open Questions

- **No hard cap on `limit`** (per user choice). The LLM could request `limit=10000` and burn its own context. Tool descriptions mitigate this; usage in practice will tell us whether to revisit.
- **MCP binary content block support** depends on the SDK version. If not available, `get_attachment` falls back to a base64 string in a text block. Decision made at implementation time; doc updated if behavior differs.
- **Saved report query derivation** — ServiceNow stores report queries as encoded `sysparm_query` strings in `sys_report.filter`. Unusual report types (PA, gauges) may not be expressible as a simple table query. v1 supports only "list" type reports; other types return a structured `unsupported_report_type` error.
