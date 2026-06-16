# snow-mcp

A **read-only Model Context Protocol (MCP) server** that exposes a
ServiceNow instance to MCP-aware clients (Claude Code, Claude Desktop,
Cursor, and any other MCP client — stdio or Streamable HTTP transport).

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

# 2. set environment variables (see Configuration below for all vars)
export SNOW_INSTANCE_URL=https://your-instance.service-now.com
export SNOW_USER=integration.user
export SNOW_PASSWORD=replace-me
# or use SNOW_OAUTH_TOKEN / SNOW_OAUTH_CLIENT_ID + SNOW_OAUTH_CLIENT_SECRET

# 3. compile and run
yarn build
yarn start
```

> **Just want to try it?** A pre-built multi-arch image is published to GHCR
> on every `main` push — skip the install/build entirely:
>
> ```bash
> docker run --rm \
>   -e SNOW_INSTANCE_URL=https://your-instance.service-now.com \
>   -e SNOW_USER=integration.user \
>   -e SNOW_PASSWORD=replace-me \
>   -p 17880:17880 \
>   ghcr.io/jmrl23/snow-mcp:main
> ```
>
> See [Container image (GHCR)](#container-image-ghcr) for tag matrix and platforms.

Alternatively, supply env vars via your MCP client's `env:` block (see
[Connecting an MCP client](#connecting-an-mcp-client)) — no separate shell
export step needed in that case.

> If you prefer a file-based approach, copy `.env.example` to `.env`, fill in
> your values, and launch with `node --env-file=.env dist/main.js` (or let
> docker-compose auto-load it for `${VAR}` substitution).

By default, `yarn start` runs the server over **stdio**: no port is opened
and the process is designed to be spawned as a child by an MCP client. Set
`MCP_TRANSPORT=http` to expose the Streamable HTTP transport on
`MCP_HTTP_HOST:MCP_HTTP_PORT` instead — see [Transport](#transport) below.
To verify configuration without a client, use `yarn dev` and watch for
startup errors.

---

## Configuration

All configuration is read from `process.env`. Set vars however your runtime
or orchestrator supports — shell exports, MCP client `env:` config blocks,
`docker run -e`, k8s Secrets, Compose `environment:`, etc. `.env.example`
lists every recognized var as a reference; see [Auth](#auth) for selection
priority.

### Required variables

| Variable                   | Required                             | Description                                                  |
| -------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| `SNOW_INSTANCE_URL`        | always                               | Must start with `https://`. Trailing slashes are stripped.   |
| `SNOW_OAUTH_CLIENT_ID`     | with `SNOW_OAUTH_CLIENT_SECRET`      | OAuth client_credentials client id. Highest auth priority.   |
| `SNOW_OAUTH_CLIENT_SECRET` | with `SNOW_OAUTH_CLIENT_ID`          | OAuth client_credentials secret. Must be paired with the id. |
| `SNOW_OAUTH_TOKEN`         | one of: cc pair, token, or user+pass | Static bearer token. Used if no client_credentials pair.     |
| `SNOW_USER`                | required if no cc pair and no token  | ServiceNow user for HTTP Basic auth.                         |
| `SNOW_PASSWORD`            | required if no cc pair and no token  | Password for HTTP Basic auth.                                |

See [Auth](#auth) below for the full selection priority.

The examples below show shell-export form. The same key-value pairs work
identically via any delivery mechanism (MCP client `env:` block,
`docker run -e`, k8s Secret, docker-compose `environment:`, etc.).

### Example — OAuth client_credentials

```bash
export SNOW_INSTANCE_URL=https://your-instance.service-now.com
export SNOW_OAUTH_CLIENT_ID=abc123
export SNOW_OAUTH_CLIENT_SECRET=replace-me
```

### Example — OAuth bearer

```bash
export SNOW_INSTANCE_URL=https://your-instance.service-now.com
export SNOW_OAUTH_TOKEN=eyJraWQiOiI...
```

### Example — HTTP Basic

```bash
export SNOW_INSTANCE_URL=https://your-instance.service-now.com
export SNOW_USER=integration.user
export SNOW_PASSWORD=replace-me
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

| Variable         | Default     | Notes                                                                             |
| ---------------- | ----------- | --------------------------------------------------------------------------------- |
| `MCP_TRANSPORT`  | `stdio`     | Set to `http` for Streamable HTTP.                                                |
| `MCP_HTTP_HOST`  | `127.0.0.1` | Only used when `MCP_TRANSPORT=http`.                                              |
| `MCP_HTTP_PORT`  | `3000`      | Only used when `MCP_TRANSPORT=http`.                                              |
| `MCP_AUTH_TOKEN` | _required_  | Shared bearer token. **Required when `MCP_TRANSPORT=http`**; ignored under stdio. |

The HTTP transport binds to localhost by default. To expose it to other machines, set `MCP_HTTP_HOST=0.0.0.0` and ensure your network/firewall is configured appropriately.

When `MCP_TRANSPORT=http`, every request to `/mcp` must include `Authorization: Bearer <MCP_AUTH_TOKEN>`. Missing or wrong tokens get a `401`. The server refuses to start if `MCP_AUTH_TOKEN` is unset or blank under http. Generate a strong value with `openssl rand -base64 32` and treat it like any other secret.

### Schema cache

`describe_table` and `list_tables` cache results to avoid repeated `sys_dictionary` and `sys_db_object` lookups. The cache is in-memory with LRU eviction (stdio and http). Defaults:

| Variable                   | Default  | Notes                                                |
| -------------------------- | -------- | ---------------------------------------------------- |
| `SCHEMA_CACHE_TTL_MS`      | `300000` | 5 minutes. Set to `0` to disable the cache.          |
| `SCHEMA_CACHE_MAX_ENTRIES` | `256`    | Hard cap on cached entries (in-memory / stdio only). |

After a schema customization in ServiceNow, restart the server or wait for the TTL to expire.

### Identity resolution

`get_user_context` resolves the calling user against `sys_user` by querying `user_name=javascript:gs.getUser().getName()`. That script-eval filter only works for accounts holding the `client_callable_script_include` privilege; without it, the lookup returns a phantom row with an empty `user_name` and the tool throws a `ConfigError`.

If you hit that error, grant `client_callable_script_include` to the account this process authenticates as, or switch to one that already has it.

---

## Connecting an MCP client

By default the server speaks MCP over **stdio**: clients spawn it as a
child process and exchange JSON-RPC frames on stdin/stdout. With
`MCP_TRANSPORT=http`, the server instead listens on
`MCP_HTTP_HOST:MCP_HTTP_PORT` (default `127.0.0.1:3000`) and clients
connect to it via URL. Both transports expose the same tools and
resources.

### Claude Code (CLI)

Add the server to `~/.claude/settings.json` (user-scoped) or a
project-scoped `.claude/settings.json`:

```json
{
  "mcpServers": {
    "snow-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/snow-mcp/dist/main.js"],
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
block, shell exports, or any other runtime mechanism that populates the
process environment.

### Remote server (HTTP transport)

Use this when snow-mcp runs on a dedicated host (VM, container, internal
server) and MCP clients connect from different machines — multi-user
shared deployments or containerised clusters where every client should
reach the same running process.

#### Server-side setup

Set `MCP_TRANSPORT=http` so the server opens a port instead of reading
stdio. See [Transport](#transport) and [Auth](#auth) for the full env
table; the additional requirements for cross-machine exposure are:

```bash
# bind to all interfaces (not just loopback)
export MCP_HTTP_HOST=0.0.0.0
export MCP_HTTP_PORT=17880

# generate a strong bearer token — keep this value secret
MCP_AUTH_TOKEN=$(openssl rand -base64 32)
export MCP_AUTH_TOKEN
```

The container image already sets `MCP_HTTP_HOST=0.0.0.0` and
`MCP_HTTP_PORT=17880` — see [Docker](#docker) for a full `docker run`
invocation with all required env vars.

> **Security — use a reverse proxy for TLS.**
> The MCP server itself does not terminate TLS — that is intentional;
> TLS is delegated to a reverse proxy (nginx, Caddy, Traefik, Envoy, or
> a cloud load-balancer) in front of snow-mcp. Without a proxy the
> bearer value travels in cleartext over plain HTTP. Configure your
> proxy to terminate HTTPS and forward to
> `http://127.0.0.1:<MCP_HTTP_PORT>` (localhost or a private-network
> address); do not expose the raw port to the public internet.

#### Claude Code (CLI)

Add to the same `~/.claude/settings.json` (user scope) or
`.claude/settings.json` (project scope) used by the stdio example
above, but with the http-transport shape:

```json
{
  "mcpServers": {
    "snow-mcp": {
      "type": "http",
      "url": "https://mcp.internal.example.com/mcp",
      "headers": {
        "Authorization": "Bearer replace-with-token-from-openssl"
      }
    }
  }
}
```

`"type": "streamable-http"` is accepted as an alias for `"http"`. Or
use the CLI (which writes the same JSON for you):

```bash
claude mcp add --transport http snow-mcp https://mcp.internal.example.com/mcp \
  --header "Authorization: Bearer replace-with-token-from-openssl"
```

Config-file locations have shifted across Claude Code versions
(`~/.claude.json`, `.mcp.json`); if `~/.claude/settings.json` doesn't
pick up the entry, check the
[current Claude Code MCP docs](https://docs.claude.com/en/docs/claude-code/mcp).

#### Claude Desktop

Claude Desktop connects to remote MCP servers through its **Connectors
UI**, not via `claude_desktop_config.json` (that file is for stdio
servers only). Open Claude Desktop → Settings → Connectors → Add custom
connector, enter `https://mcp.internal.example.com/mcp`, and complete
the authentication prompt. Verify against the
[current upstream docs](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)
if the flow has changed.

#### Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in the
project root:

```json
{
  "mcpServers": {
    "snow-mcp": {
      "url": "https://mcp.internal.example.com/mcp",
      "headers": {
        "Authorization": "Bearer replace-with-token-from-openssl"
      }
    }
  }
}
```

No `type` field is required — Cursor infers HTTP transport from the
`url` field. Verify against the
[Cursor MCP docs](https://cursor.com/docs/context/mcp)
if the shape has changed.

#### Verifying the connection

From any machine with network access to the server, confirm the endpoint
is reachable and the bearer is accepted:

```bash
curl -s \
  -H "Authorization: Bearer replace-with-token-from-openssl" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  https://mcp.internal.example.com/mcp
```

A JSON response containing `"result"` and `"serverInfo"` confirms the
server is up and the bearer is valid. From within a connected client,
ask the assistant to list available MCP tools — you should see eight
tools under `snow-mcp`.

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

```text
┌────────────────────┐  stdio or HTTP (JSON-RPC) ┌────────────────────┐
│   MCP client       │ ───────────────────────▶  │   snow-mcp         │
│ (Claude Code, etc.)│ ◀───────────────────────  │ (this server)      │
└────────────────────┘                           └─────────┬──────────┘
                                                           │ HTTPS GET
                                                           ▼
                                                 ┌────────────────────┐
                                                 │ ServiceNow REST    │
                                                 │ /api/now/table/*   │
                                                 │ /api/now/stats/*   │
                                                 │ /api/now/attachment│
                                                 └────────────────────┘
```

Transport is selected by `MCP_TRANSPORT` (default `stdio`; `http` for
Streamable HTTP). See [Transport](#transport).

Code layout (under `src/`):

| Layer              | Purpose                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `main.ts`          | Boot: load config, build client, connect MCP transport (stdio or HTTP). |
| `config.ts`        | Env parsing + validation. Throws `ConfigError` on bad input.            |
| `errors.ts`        | Typed error hierarchy (`ServiceNowAuthError`, `…NotFoundError`, …).     |
| `http/`            | Fetch wrapper, retry/backoff, ServiceNow error translation.             |
| `servicenow/`      | One module per ServiceNow API surface (table, aggregate, report …).     |
| `servicenow/auth/` | Auth providers (basic, static bearer, OAuth client_credentials).        |
| `mcp/server.ts`    | Registers tools + resources on an `McpServer`.                          |
| `mcp/tools/*`      | One file per MCP tool (input schema + handler).                         |
| `mcp/resources/*`  | MCP resources (currently: `servicenow://tables`).                       |
| `mcp/transport/*`  | Transport factory (`stdio.ts`, `http.ts`, `index.ts` selector).         |

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

## Docker

The repo ships a multi-stage Dockerfile that produces a minimal,
distroless runtime image. The builder stage compiles TypeScript on
`node:24-alpine`; the final image is
`gcr.io/distroless/nodejs24-debian12:nonroot` with only
`dist/`, production `node_modules`, and `package.json` copied in.

### Build

```bash
docker build -t snow-mcp:local .
```

### Run

The container defaults to the Streamable HTTP transport on port
`17880` and binds `0.0.0.0` inside the container. Pass credentials
via `-e` flags (or forwarded from your shell env) and map the port:

```bash
docker run --rm \
  -e SNOW_INSTANCE_URL=https://your-instance.service-now.com \
  -e SNOW_USER=integration.user \
  -e SNOW_PASSWORD=replace-me \
  -p 17880:17880 \
  snow-mcp:local
```

If you prefer a file, `--env-file .env` is an equivalent alternative:

```bash
docker run --rm --env-file .env -p 17880:17880 snow-mcp:local
```

### Compose

```bash
# Export credentials in your shell first, then:
docker compose up --build
```

The provided `docker-compose.yml` substitutes `${VAR}` from your shell
environment and forces `MCP_TRANSPORT=http`, `MCP_HTTP_HOST=0.0.0.0`,
`MCP_HTTP_PORT=17880`. If you prefer a file, compose also auto-loads
`.env` from the project directory for `${VAR}` substitution — no flag
needed; just have a `.env` present.

To run the pre-built image from GHCR instead of building locally, use
`docker-compose.ghcr.yml`. It accepts the same environment variables
with the same defaults — no other changes needed:

```bash
docker compose -f docker-compose.ghcr.yml up
```

### Use a different port

The container's bind port is `MCP_HTTP_PORT` (default `17880`).
Override both the env var and the published port together:

```bash
docker run --rm \
  -e SNOW_INSTANCE_URL=https://your-instance.service-now.com \
  -e SNOW_USER=integration.user \
  -e SNOW_PASSWORD=replace-me \
  -e MCP_AUTH_TOKEN=replace-with-strong-secret \
  -e MCP_HTTP_PORT=8443 \
  -p 8443:8443 \
  snow-mcp:local
```

### Container image (GHCR)

Pre-built multi-arch images are published to GitHub Container Registry
on every push to `main` and on every `v*` git tag. Pull the latest:

```bash
docker pull ghcr.io/jmrl23/snow-mcp:main
```

Supported tags:

| Tag             | When it's published                         |
| --------------- | ------------------------------------------- |
| `latest`        | every `v*` semver tag push (non-prerelease) |
| `main`          | every push to the `main` branch             |
| `vX.Y.Z`        | every `v*` git tag (literal tag name)       |
| `X.Y.Z` / `X.Y` | every `v*` semver tag (`v` prefix stripped) |
| `sha-<short>`   | every push (immutable per commit)           |

Supported platforms: `linux/amd64`, `linux/arm64`.

Run the published image by substituting `ghcr.io/jmrl23/snow-mcp:main`
for `snow-mcp:local` in any `docker run` example above. For Compose, use
the ready-made `docker-compose.ghcr.yml` (see [§ Compose](#compose)).

### Updating tables of project layout

No need — `Dockerfile`, `.dockerignore`, and `docker-compose.yml` at
the repo root are visible in the existing tree.

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
  - Never commit files containing live secret values (`.env`, credential
    dumps, etc.). `.env` is gitignored as a safeguard.
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
| `Missing required configuration: SNOW_INSTANCE_URL`     | Env var not set or empty. Confirm your shell exports, MCP client `env:` block, or `-e` flag includes the var.        |
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

```text
snow-mcp/
├── CLAUDE.md                 # project-wide guidance for Claude Code
├── README.md                 # you are here
├── .claude/
│   └── rules/                # code-quality, testing, security, error-handling
├── .env                      # optional local secrets file (gitignored)
├── .env.example              # reference list of every recognized env var
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js
├── Dockerfile
├── .dockerignore
├── docker-compose.yml
├── docker-compose.ghcr.yml   # pulls from GHCR (no local build)
├── src/
│   ├── main.ts               # entry point (selects transport from config)
│   ├── config.ts             # env parsing & validation
│   ├── errors.ts             # typed error hierarchy
│   ├── http/                 # fetch wrapper, retry, error translation
│   ├── servicenow/
│   │   ├── client.ts         # composes the per-API modules
│   │   ├── auth/             # AuthProvider + basic / bearer / oauth-cc
│   │   ├── schema-cache.ts   # TTL+LRU cache used by describe_table/list_tables
│   │   └── …                 # one file per ServiceNow API surface
│   └── mcp/
│       ├── server.ts         # registers tools + resources
│       ├── tool-helpers.ts
│       ├── tools/            # one file per MCP tool
│       ├── transport/        # stdio.ts, http.ts, index.ts (selector)
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

- [`CLAUDE.md`](./CLAUDE.md) — guidance for Claude Code working in this repo.
- [`.claude/rules/`](./.claude/rules/) — code-quality, testing, security, and error-handling rules.

---

## License

MIT. See `package.json` for the declared license field.
