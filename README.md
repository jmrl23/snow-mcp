# snow-mcp

A **read-only Model Context Protocol (MCP) server** that exposes a
ServiceNow instance to MCP-aware clients (Claude Code, Claude Desktop,
Cursor, and any other stdio MCP client).

It lets an LLM:

- discover tables and their schemas,
- run filtered queries with pagination,
- fetch individual records,
- download attachments,
- run aggregate queries (count / sum / avg / min / max, with grouping),
- execute saved list reports,
- inspect the calling user's roles and group memberships.

The server **never mutates ServiceNow** — only `GET` is permitted across
the HTTP boundary. Attempted writes are blocked at the client layer with
a `ReadOnlyViolationError`.

---

## Table of contents

1. [Requirements](#requirements)
2. [Quick start](#quick-start)
3. [Configuration](#configuration)
4. [Connecting an MCP client](#connecting-an-mcp-client)
5. [Tools](#tools)
6. [Resources](#resources)
7. [Architecture](#architecture)
8. [Development](#development)
9. [Testing](#testing)
10. [Security & operational notes](#security--operational-notes)
11. [Troubleshooting](#troubleshooting)
12. [Project layout](#project-layout)
13. [Further reading](#further-reading)
14. [License](#license)

---

## Requirements

- **Node.js 24+** (ESM, modern built-ins).
- **Yarn** (the repo ships a `yarn.lock`).
- A ServiceNow instance reachable over **HTTPS** with read access for
  the credentials you intend to use.

---

## Quick start

```bash
# 1. install
yarn install

# 2. create .env (see Configuration below)
cp /dev/null .env
$EDITOR .env

# 3. compile and run
yarn build
yarn start
```

`yarn start` runs the server over **stdio**. It does not open a port — it
is designed to be spawned as a child process by an MCP client. To verify
configuration without a client, use `yarn dev` and watch for startup
errors.

---

## Configuration

All configuration is read from environment variables. In local
development they typically come from a project-local `.env` file (which
is gitignored — never commit it).

### Required variables

| Variable            | Required                      | Description                                                |
| ------------------- | ----------------------------- | ---------------------------------------------------------- |
| `SNOW_INSTANCE_URL` | always                        | Must start with `https://`. Trailing slashes are stripped. |
| `SNOW_OAUTH_TOKEN`  | one of token **or** user+pass | Bearer token. Takes precedence when set.                   |
| `SNOW_USER`         | required if no token          | ServiceNow user for HTTP Basic auth.                       |
| `SNOW_PASSWORD`     | required if no token          | Password for HTTP Basic auth.                              |

### Example — OAuth bearer

```dotenv
SNOW_INSTANCE_URL=https://your-instance.service-now.com
SNOW_OAUTH_TOKEN=eyJraWQiOiI...
```

### Example — HTTP Basic

```dotenv
SNOW_INSTANCE_URL=https://your-instance.service-now.com
SNOW_USER=integration.user
SNOW_PASSWORD=replace-me
```

### Startup validation

`src/config.ts` enforces, at boot:

- `SNOW_INSTANCE_URL` is present and starts with `https://`.
- The URL parses as a valid URL.
- Either `SNOW_OAUTH_CLIENT_ID` + `SNOW_OAUTH_CLIENT_SECRET`, **or**
  `SNOW_OAUTH_TOKEN`, **or** both `SNOW_USER` + `SNOW_PASSWORD` are
  provided.

Failures throw a `ConfigError` and the process exits non-zero — secrets
are **never** echoed in the error message.

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

### Schema cache

`describe_table` and `list_tables` cache results in memory to avoid repeated `sys_dictionary` and `sys_db_object` lookups. Defaults:

| Variable                   | Default  | Notes                                       |
| -------------------------- | -------- | ------------------------------------------- |
| `SCHEMA_CACHE_TTL_MS`      | `300000` | 5 minutes. Set to `0` to disable the cache. |
| `SCHEMA_CACHE_MAX_ENTRIES` | `256`    | Hard cap on cached entries per tool.        |

After a schema customization in ServiceNow, restart the server or wait for the TTL to expire.

---

## Connecting an MCP client

The server speaks MCP over stdio, so any client that supports stdio MCP
servers can launch it.

### Claude Code (CLI)

Add the server to `~/.claude/settings.json` (user-scoped) or a
project-scoped `.claude/settings.json`:

```json
{
  "mcpServers": {
    "snow-mcp": {
      "command": "node",
      "args": ["/home/master/mcp/snow-mcp/dist/main.js"],
      "env": {
        "SNOW_INSTANCE_URL": "https://your-instance.service-now.com",
        "SNOW_OAUTH_TOKEN": "eyJraWQiOiI..."
      }
    }
  }
}
```

Restart Claude Code. Tools appear under the `mcp__snow-mcp__*` namespace
(`mcp__snow-mcp__query_table`, etc.).

> Pin the entry to `dist/main.js` after `yarn build` for reliable
> startup. Use `yarn dev` only when iterating on the server source.

### Claude Desktop

Edit `claude_desktop_config.json` (location depends on OS — see Claude
Desktop docs). Same shape:

```json
{
  "mcpServers": {
    "snow-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/snow-mcp/dist/main.js"],
      "env": {
        "SNOW_INSTANCE_URL": "https://your-instance.service-now.com",
        "SNOW_USER": "integration.user",
        "SNOW_PASSWORD": "replace-me"
      }
    }
  }
}
```

### Cursor / other stdio MCP clients

Use the same `command` + `args` + `env` triplet. The server reads
credentials only from `process.env`; pass them via the client's `env`
block or via a sourced `.env`.

### Verifying

After the client restarts, ask it to list available MCP tools. You
should see eight tools under `snow-mcp` and one resource
(`servicenow://tables`).

---

## Tools

All tools are read-only. Inputs use `snake_case`. Errors are returned to
the client as structured MCP error content blocks (`isError: true`) —
never as uncaught exceptions across the MCP boundary.

### `list_tables`

List ServiceNow tables visible to the authenticated user.

| Arg      | Type   | Required | Description                                        |
| -------- | ------ | -------- | -------------------------------------------------- |
| `filter` | string | no       | Case-insensitive substring on table name or label. |

Returns `[{ name, label, super_class }, ...]`.

### `describe_table`

Return a table's label, parent, and field definitions (from
`sys_dictionary`).

| Arg    | Type   | Required | Description                             |
| ------ | ------ | -------- | --------------------------------------- |
| `name` | string | yes      | Table name, e.g. `incident`, `cmdb_ci`. |

Returns `{ name, label, parent, fields: [{ name, label, type, reference?, mandatory, readOnly }, ...] }`.
Returns a `404`-style error when the table is unknown.

### `query_table`

Page through any ServiceNow table.

| Arg             | Type                 | Required | Description                                                   |
| --------------- | -------------------- | -------- | ------------------------------------------------------------- |
| `table`         | string               | yes      | Table name.                                                   |
| `sysparm_query` | string               | no       | ServiceNow encoded query, e.g. `priority=1^stateIN1,2`.       |
| `fields`        | string[]             | no       | Field allowlist. Omit to return all readable fields.          |
| `limit`         | int > 0              | no       | Page size. **Default 25.** Large values inflate context cost. |
| `offset`        | int ≥ 0              | no       | Row offset for pagination.                                    |
| `display_value` | `true`/`false`/`all` | no       | ServiceNow display-value mode.                                |

Returns `{ records, total?, next_offset? }`. Prefer narrow `fields` and
small `limit` — output is streamed back into the client's context.

### `get_record`

Fetch one record by `sys_id`.

| Arg      | Type     | Required | Description                                    |
| -------- | -------- | -------- | ---------------------------------------------- |
| `table`  | string   | yes      | Table name.                                    |
| `sys_id` | string   | yes      | The record's `sys_id`.                         |
| `fields` | string[] | no       | Field allowlist. Omit for all readable fields. |

### `get_attachment`

Download an attachment by `sys_id` (the row in `sys_attachment`).

| Arg      | Type   | Required | Description                         |
| -------- | ------ | -------- | ----------------------------------- |
| `sys_id` | string | yes      | Attachment row in `sys_attachment`. |

Returns the attachment's metadata plus the file contents as **base64**.

### `aggregate`

Run a ServiceNow aggregate query.

| Arg             | Type                            | Required             | Description                                    |
| --------------- | ------------------------------- | -------------------- | ---------------------------------------------- |
| `table`         | string                          | yes                  | Table name.                                    |
| `operation`     | `count`/`avg`/`sum`/`min`/`max` | yes                  | Aggregate function.                            |
| `field`         | string                          | only for non-`count` | Field to aggregate over.                       |
| `group_by`      | string[]                        | no                   | Group rows by these fields before aggregating. |
| `sysparm_query` | string                          | no                   | Optional encoded query for filtering.          |

Ungrouped responses come back as a single object; grouped responses as
an array (one entry per group).

### `run_saved_report`

Execute a saved list-type report from `sys_report`.

| Arg             | Type    | Required | Description                        |
| --------------- | ------- | -------- | ---------------------------------- |
| `report_sys_id` | string  | yes      | `sys_id` of a row in `sys_report`. |
| `limit`         | int > 0 | no       | Page size. Default 25.             |
| `offset`        | int ≥ 0 | no       | Row offset for pagination.         |

Returns the records produced by the report plus the report's definition.
v1 supports **list** reports only.

### `get_user_context`

Return the authenticated user (`user_name`, `sys_id`, `name`, `email`),
their roles, and their group memberships. No inputs.

---

## Resources

### `servicenow://tables`

A live JSON catalog of every table visible to the authenticated user
(`name`, `label`, `super_class`, `sys_id`). Useful for autocompletion
and table discovery without paying for repeated `list_tables` calls.

---

## Architecture

```
┌────────────────────┐     stdio (JSON-RPC)     ┌────────────────────┐
│   MCP client       │ ───────────────────────▶ │   snow-mcp         │
│ (Claude Code, etc.)│ ◀─────────────────────── │ (this server)      │
└────────────────────┘                          └─────────┬──────────┘
                                                          │ HTTPS GET
                                                          ▼
                                                ┌────────────────────┐
                                                │ ServiceNow REST    │
                                                │ /api/now/table/*   │
                                                │ /api/now/stats/*   │
                                                │ /api/now/attachment│
                                                └────────────────────┘
```

Code layout (under `src/`):

| Layer             | Purpose                                                             |
| ----------------- | ------------------------------------------------------------------- |
| `main.ts`         | Boot: load config, build client, start stdio MCP server.            |
| `config.ts`       | Env parsing + validation. Throws `ConfigError` on bad input.        |
| `errors.ts`       | Typed error hierarchy (`ServiceNowAuthError`, `…NotFoundError`, …). |
| `http/`           | Fetch wrapper, retry/backoff, ServiceNow error translation.         |
| `servicenow/`     | One module per ServiceNow API surface (table, aggregate, report …). |
| `mcp/server.ts`   | Registers tools + resources on an `McpServer`.                      |
| `mcp/tools/*`     | One file per MCP tool (input schema + handler).                     |
| `mcp/resources/*` | MCP resources (currently: `servicenow://tables`).                   |

Transient ServiceNow errors (5xx, `429`, `ECONNRESET`) are retried with
exponential backoff and jitter in `src/http/retry.ts`. 4xx auth /
validation errors fail fast.

---

## Development

```bash
yarn dev          # tsx watch on src/main.ts (live reload)
yarn build        # tsc → dist/
yarn start        # node dist/main.js
yarn typecheck    # tsc --noEmit
yarn lint         # eslint
yarn lint:fix     # eslint --fix
yarn format       # prettier --write .
yarn format:check # prettier --check .
```

### Conventions

- TypeScript, strict mode, ESM, kebab-case filenames.
- Named exports preferred; one component / class per file.
- Booleans use `is` / `has` / `should` / `can` prefixes.
- ServiceNow-specific casing: `sysId`, `sysparmQuery`, `tableName`.
- Code markers use `TODO(author): desc (#issue)` / `FIXME` / `HACK` / `NOTE`.
- See `.claude/rules/code-quality.md` for the full rule set.

---

## Testing

Framework: **Vitest**. Tests live next to source as `*.test.ts`.

```bash
yarn test                          # full suite
yarn test src/http/client.test.ts  # one file
yarn test:watch                    # watch mode
```

Rules (see `.claude/rules/testing.md`):

- Verify behavior, not implementation.
- Mock only at the HTTP boundary — never hit a real ServiceNow
  instance from unit tests.
- Fake credentials in fixtures only (e.g.
  `https://example.service-now.com`, `test-user`).
- One assertion per test; Arrange-Act-Assert; no loops/`if` in tests.

---

## Security & operational notes

- **Read-only by design.** The server refuses to issue
  `POST`/`PUT`/`PATCH`/`DELETE` against ServiceNow. Do not add mutation
  endpoints — open a discussion instead.
- **HTTPS only.** Non-`https://` instance URLs are rejected at startup.
- **Secrets hygiene.**
  - `.env` is gitignored.
  - `Authorization`, cookies, and `SNOW_*` values are redacted before
    any log line.
  - Errors crossing the MCP boundary have ServiceNow stack traces,
    server hostnames, and `SNOW_*` values stripped.
- **Input validation.** Table names, encoded queries, and field names
  from the MCP client are allowlisted/escaped before being forwarded to
  ServiceNow.
- **Retries.** Transient errors retry with exponential backoff and
  jitter; 4xx auth/validation errors fail fast.
- **Pagination.** `query_table` exposes `total` and `next_offset` so
  callers can page large result sets without re-querying blindly.

See `.claude/rules/security.md` and `.claude/rules/error-handling.md`
for the project's full security and error-handling rules.

---

## Troubleshooting

| Symptom                                                 | Likely cause / fix                                                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `Missing required configuration: SNOW_INSTANCE_URL`     | `.env` not loaded, or the variable is empty. Confirm the file path and that the client passes `env`.                 |
| `SNOW_INSTANCE_URL must use https://`                   | The server refuses non-HTTPS instances. Use the full `https://...` URL.                                              |
| `401` / `ServiceNowAuthError` from tool calls           | Bearer token expired or user/password incorrect. Rotate the credential.                                              |
| `404` / `ServiceNowNotFoundError` from `describe_table` | Table name misspelled, or the user lacks read ACL on `sys_db_object` for it.                                         |
| `429` or 5xx errors                                     | Transient — the HTTP layer already retries with exponential backoff + jitter. Persistent failures = instance health. |
| Tool output blows context budget                        | Reduce `limit`, narrow `fields`, or paginate via `next_offset`.                                                      |
| Client sees no tools after restart                      | Check the client's MCP logs; usually a bad `command`/`args` path or the server crashing on startup.                  |

### Inspecting stderr

When launched by an MCP client, the server's `stderr` is the only place
startup errors surface. Most clients expose this in their MCP server
logs (Claude Desktop: _Settings → Developer → Open MCP Logs_).

### Local smoke test

```bash
yarn dev
# If it stays up without printing an error, config & auth are OK.
# Ctrl-C to stop.
```

For functional checks, prefer the test suite:

```bash
yarn test src/servicenow
```

---

## Project layout

```
snow-mcp/
├── CLAUDE.md                 # project-wide guidance for Claude Code
├── README.md                 # you are here
├── USAGE.md                  # connection + tool quick reference
├── .claude/
│   └── rules/                # code-quality, testing, security, error-handling
├── .env                      # local credentials (gitignored)
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js
├── src/
│   ├── main.ts               # stdio entry point
│   ├── config.ts             # env parsing & validation
│   ├── errors.ts             # typed error hierarchy
│   ├── http/                 # fetch wrapper, retry, error translation
│   ├── servicenow/           # ServiceNow REST API wrappers
│   └── mcp/
│       ├── server.ts         # registers tools + resources
│       ├── tool-helpers.ts
│       ├── tools/            # one file per MCP tool
│       └── resources/        # MCP resources
└── dist/                     # compiled output (yarn build)
```

---

## Further reading

- **Model Context Protocol** — <https://modelcontextprotocol.io>
- **MCP TypeScript SDK** — <https://github.com/modelcontextprotocol/typescript-sdk>
- **ServiceNow Table API** — <https://developer.servicenow.com/dev.do#!/reference/api/latest/rest/c_TableAPI>
- **ServiceNow Aggregate API** — <https://developer.servicenow.com/dev.do#!/reference/api/latest/rest/c_AggregateAPI>
- **ServiceNow Attachment API** — <https://developer.servicenow.com/dev.do#!/reference/api/latest/rest/c_AttachmentAPI>
- **ServiceNow Encoded Query syntax** — <https://docs.servicenow.com/bundle/utah-platform-user-interface/page/use/common-ui-elements/reference/r_OpAvailableFiltersQueries.html>
- **Claude Code MCP docs** — <https://docs.claude.com/en/docs/claude-code/mcp>
- **Claude Desktop MCP docs** — <https://modelcontextprotocol.io/docs/quickstart>

Project-internal docs you may also want:

- [`USAGE.md`](./USAGE.md) — focused connection + tool quick reference.
- [`CLAUDE.md`](./CLAUDE.md) — guidance for Claude Code working in this repo.
- [`.claude/rules/`](./.claude/rules/) — code-quality, testing, security, and error-handling rules.

---

## License

MIT. See `package.json` for the declared license field.
