# snow-mcp — Connection & Usage

Read-only MCP server that exposes a ServiceNow instance to MCP-aware clients
(Claude Code, Claude Desktop, Cursor, any MCP client over stdio or
Streamable HTTP).

This document covers:

1. Prerequisites
2. Configuration
3. Building & running
4. Wiring the server into an MCP client
5. Tool reference
6. Resource reference
7. Troubleshooting

---

## 1. Prerequisites

- **Node.js 24+** (the project uses ESM and modern Node APIs).
- **Yarn** (the lockfile is `yarn.lock`).
- A ServiceNow instance reachable over **HTTPS** and credentials for it — one of:
  - **OAuth client_credentials** (`SNOW_OAUTH_CLIENT_ID` + `SNOW_OAUTH_CLIENT_SECRET`) — highest priority,
  - an **OAuth bearer token** (`SNOW_OAUTH_TOKEN`), or
  - a **username + password** (`SNOW_USER` + `SNOW_PASSWORD`) for HTTP Basic auth.

The authenticated user only needs read access; the server never issues
`POST` / `PUT` / `PATCH` / `DELETE` against ServiceNow.

---

## 2. Configuration

Configuration is read from `process.env`. Provide env vars however your
runtime or orchestrator supports — shell exports, MCP client `env:` config
blocks, `docker run -e`, k8s Secrets, Compose `environment:`, etc.
`.env.example` lists every recognized var as a reference.

Set **one** of three auth forms. Selection is implicit by which vars are set.
**Priority:** `client_credentials > static bearer > basic`.

### Option A — OAuth client_credentials (recommended for server-to-server)

```
SNOW_INSTANCE_URL=https://your-instance.service-now.com
SNOW_OAUTH_CLIENT_ID=abc123
SNOW_OAUTH_CLIENT_SECRET=replace-me
```

The server POSTs `${SNOW_INSTANCE_URL}/oauth_token.do` with
`grant_type=client_credentials`, caches the token until 30s before
expiry, and refreshes automatically (also on a 401 from the ServiceNow
API).

### Option B — OAuth bearer token

```
SNOW_INSTANCE_URL=https://your-instance.service-now.com
SNOW_OAUTH_TOKEN=eyJraWQiOiI...
```

### Option C — Basic auth

```
SNOW_INSTANCE_URL=https://your-instance.service-now.com
SNOW_USER=integration.user
SNOW_PASSWORD=replace-me
```

### How to provide env vars

- **Shell:** `export SNOW_INSTANCE_URL=... && export SNOW_USER=... && yarn start`
- **MCP client `env:` config (Claude Code, Claude Desktop, Cursor):** populate the `env` dict in the server entry (see §4); values are forwarded to the spawned process.
- **Docker:** `docker run -e SNOW_INSTANCE_URL=... -e SNOW_USER=... -e SNOW_PASSWORD=... snow-mcp:local`
- **docker-compose:** an `environment:` block with `${VAR}` substitution (compose interpolates from your shell, and also auto-loads `.env` from the project dir _into the interpolation scope_ — not into the container directly), or `env_file:` which injects a file's vars straight into the container's environment
- **`.env` file + node:** `node --env-file=.env dist/main.js` if you prefer a file-based approach

Rules enforced at startup (`src/config.ts`):

| Variable                   | Required              | Notes                                                                 |
| -------------------------- | --------------------- | --------------------------------------------------------------------- |
| `SNOW_INSTANCE_URL`        | yes                   | Must start with `https://`. Trailing slashes stripped.                |
| `SNOW_OAUTH_CLIENT_ID`     | with CLIENT_SECRET    | OAuth cc client id. Highest priority. Must be paired with the secret. |
| `SNOW_OAUTH_CLIENT_SECRET` | with CLIENT_ID        | OAuth cc secret. Never logged. Never echoed in errors.                |
| `SNOW_OAUTH_TOKEN`         | one of A / B / C      | Static bearer; used when no client_credentials pair is set.           |
| `SNOW_USER`                | required for Option C | Ignored when an OAuth credential is set.                              |
| `SNOW_PASSWORD`            | required for Option C | Never logged. Never echoed in errors.                                 |

If no auth form is satisfied (or partial OAuth cc credentials, or the
URL is missing/non-HTTPS), the process exits with a `ConfigError`.

### Transport

`MCP_TRANSPORT` selects how clients reach the server. **Default `stdio`.**

| Variable        | Default     | Notes                                                  |
| --------------- | ----------- | ------------------------------------------------------ |
| `MCP_TRANSPORT` | `stdio`     | Set to `http` for the Streamable HTTP transport.       |
| `MCP_HTTP_HOST` | `127.0.0.1` | Bind address. Only used when `MCP_TRANSPORT=http`.     |
| `MCP_HTTP_PORT` | `3000`      | Bind port (1–65535). Only used when transport is HTTP. |

The HTTP transport binds to localhost by default. To expose it to other
machines, set `MCP_HTTP_HOST=0.0.0.0` and ensure your network/firewall
is configured appropriately.

### Schema cache

`describe_table` and `list_tables` cache results in memory.

| Variable                   | Default  | Notes                                       |
| -------------------------- | -------- | ------------------------------------------- |
| `SCHEMA_CACHE_TTL_MS`      | `300000` | 5 minutes. Set to `0` to disable the cache. |
| `SCHEMA_CACHE_MAX_ENTRIES` | `256`    | Hard cap on cached entries per tool.        |

After a schema customization in ServiceNow, restart the server or wait
for the TTL to expire.

### Identity resolution

`get_user_context` resolves the calling user against `sys_user`. The
default lookup uses `user_name=javascript:gs.getUser().getName()`, which
only resolves for accounts holding the `client_callable_script_include`
privilege. Without it the lookup returns a phantom empty row; the tool
now throws a `ConfigError` rather than masking that as success.

| Variable                  | Default                            | Notes                                                                   |
| ------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| `SNOW_AUTHENTICATED_USER` | `SNOW_USER` when basic auth is set | Filters `sys_user` by this `user_name` directly; skips the script eval. |

Set `SNOW_AUTHENTICATED_USER` explicitly when using OAuth bearer or
client_credentials, or when the basic-auth user lacks script-eval rights.

---

## 3. Building & running

```bash
yarn install        # one-time
yarn build          # compiles TypeScript to dist/
yarn start          # node dist/main.js
```

For local development with live reload:

```bash
yarn dev            # tsx watch on src/main.ts
```

By default the server speaks **MCP over stdio**: it does not open a
port and is designed to be spawned as a child process by an MCP client.
Set `MCP_TRANSPORT=http` to expose the **Streamable HTTP** transport on
`MCP_HTTP_HOST:MCP_HTTP_PORT` (default `127.0.0.1:3000`) — clients then
connect by URL instead of spawning the binary.

Sanity checks:

```bash
yarn typecheck      # tsc --noEmit
yarn lint           # eslint
yarn test           # vitest run (unit tests only, no live ServiceNow)
```

---

## 4. Wiring into an MCP client

Most MCP clients spawn the server over stdio; some (e.g. claude.ai web
or self-hosted gateways) connect to a Streamable HTTP endpoint. Both
work — examples below cover the stdio pattern.

The `env: {}` block in MCP client configs is one of the supported env-var
delivery patterns — the same vars described in §2 apply regardless of
whether they come from an `env:` block, shell exports, or another source.

### Claude Code (CLI)

Add an entry under `mcpServers` in your Claude Code config
(e.g. `~/.claude/settings.json` or a project-scoped `.claude/settings.json`):

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
(e.g. `mcp__snow-mcp__query_table`).

> Prefer pinning to `dist/main.js` after `yarn build` for predictable
> startup. Use `yarn dev` only when iterating on the server itself.

---

**Using the GHCR image instead** — skip the local clone + `yarn build`
by pointing at the published image:

```json
{
  "mcpServers": {
    "snow-mcp": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-e",
        "SNOW_INSTANCE_URL",
        "-e",
        "SNOW_OAUTH_TOKEN",
        "-e",
        "MCP_TRANSPORT",
        "ghcr.io/jmrl23/snow-mcp:main"
      ],
      "env": {
        "SNOW_INSTANCE_URL": "https://your-instance.service-now.com",
        "SNOW_OAUTH_TOKEN": "eyJraWQiOiI...",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

`-i` keeps the container's stdin open for the MCP client's JSON-RPC
stream. `MCP_TRANSPORT=stdio` overrides the image's default of `http`.
Forwarding env vars by name (`-e SNOW_OAUTH_TOKEN`, no `=value`) keeps
secrets out of the args array, which `ps` and journald may log.

### Claude Desktop

Edit `claude_desktop_config.json` (location depends on OS — see Claude
Desktop docs). Same shape as above:

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

---

**Using the GHCR image instead** — same shape, but `command: docker`
with `args` forwarding env vars into a container:

```json
{
  "mcpServers": {
    "snow-mcp": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-e",
        "SNOW_INSTANCE_URL",
        "-e",
        "SNOW_USER",
        "-e",
        "SNOW_PASSWORD",
        "-e",
        "MCP_TRANSPORT",
        "ghcr.io/jmrl23/snow-mcp:main"
      ],
      "env": {
        "SNOW_INSTANCE_URL": "https://your-instance.service-now.com",
        "SNOW_USER": "integration.user",
        "SNOW_PASSWORD": "replace-me",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

`-i` keeps the container's stdin open. `MCP_TRANSPORT=stdio` is
required because the image's default transport is `http`.

### Cursor / other stdio MCP clients

Use the same `command` + `args` + `env` triplet. The server reads
credentials only from `process.env`; pass them via the client's `env`
block, shell exports, or any other mechanism that populates the process
environment.

For the Docker variant, copy the Claude Desktop GHCR JSON above and
adjust the auth env vars to whichever form your setup uses.

### Verifying the connection

After the client restarts, ask it to list available MCP tools. You should
see eight tools under `snow-mcp` (see §5) and one resource
(`servicenow://tables`).

### Running in Docker

Two paths: pull the pre-built multi-arch image from GHCR (faster, no
local Node toolchain needed), or build from the included Dockerfile
(useful if you're hacking on the source).

Either way the container defaults to the HTTP transport on port
`17880`. Pass credentials via `-e` flags.

#### Pull the pre-built image (recommended)

```bash
docker run --rm \
  -e SNOW_INSTANCE_URL=https://your-instance.service-now.com \
  -e SNOW_USER=integration.user \
  -e SNOW_PASSWORD=replace-me \
  -p 17880:17880 \
  ghcr.io/jmrl23/snow-mcp:main
```

Supports `linux/amd64` and `linux/arm64`. See the README's
[Container image (GHCR)](README.md#container-image-ghcr) section for
the full tag matrix (`latest`, `main`, `sha-<short>`, semver patterns).

#### Build locally

Useful when you've modified the source and want a `:local` image
without pushing anywhere:

```bash
docker build -t snow-mcp:local .
docker run --rm \
  -e SNOW_INSTANCE_URL=https://your-instance.service-now.com \
  -e SNOW_USER=integration.user \
  -e SNOW_PASSWORD=replace-me \
  -p 17880:17880 \
  snow-mcp:local
```

See the [Docker](README.md#docker) section in the README for compose
and port-override examples.

---

## 5. Tool reference

All tools are read-only. Inputs use snake_case; arrays/strings as noted.

### `list_tables`

List ServiceNow tables visible to the authenticated user.

| Arg      | Type   | Required | Description                                        |
| -------- | ------ | -------- | -------------------------------------------------- |
| `filter` | string | no       | Case-insensitive substring on table name or label. |

Returns `[{ name, label, super_class }, ...]`.

### `describe_table`

Return a table's label, parent, and field definitions (from `sys_dictionary`).

| Arg    | Type   | Required | Description                             |
| ------ | ------ | -------- | --------------------------------------- |
| `name` | string | yes      | Table name, e.g. `incident`, `cmdb_ci`. |

Returns `{ name, label, parent, fields: [{ name, label, type, reference?, mandatory, readOnly }, ...] }`.
Throws `404` if the table does not exist.

### `query_table`

Page through any ServiceNow table.

| Arg             | Type                 | Required | Description                                                   |
| --------------- | -------------------- | -------- | ------------------------------------------------------------- |
| `table`         | string               | yes      | Table name.                                                   |
| `sysparm_query` | string               | no       | ServiceNow encoded query, e.g. `priority=1^stateIN1,2`.       |
| `fields`        | string[]             | no       | Field allowlist. Omit for all readable fields.                |
| `limit`         | int > 0              | no       | Page size. **Default 25.** Large values inflate context cost. |
| `offset`        | int ≥ 0              | no       | Row offset for pagination.                                    |
| `display_value` | `true`/`false`/`all` | no       | ServiceNow display-value mode.                                |

Returns `{ records, total?, next_offset? }`. Always prefer narrow `fields`
and small `limit` — output is shipped through the MCP client's context.

### `get_record`

Fetch one record by `sys_id`.

| Arg      | Type     | Required | Description                                    |
| -------- | -------- | -------- | ---------------------------------------------- |
| `table`  | string   | yes      | Table name.                                    |
| `sys_id` | string   | yes      | The record's `sys_id`.                         |
| `fields` | string[] | no       | Field allowlist. Omit for all readable fields. |

### `get_attachment`

Download an attachment.

| Arg      | Type   | Required | Description                                  |
| -------- | ------ | -------- | -------------------------------------------- |
| `sys_id` | string | yes      | Row in `sys_attachment` (the attachment ID). |

Returns metadata plus the file contents as **base64**.

### `aggregate`

Run a ServiceNow aggregate query.

| Arg             | Type                            | Required             | Description                                    |
| --------------- | ------------------------------- | -------------------- | ---------------------------------------------- |
| `table`         | string                          | yes                  | Table name.                                    |
| `operation`     | `count`/`avg`/`sum`/`min`/`max` | yes                  | Aggregate function.                            |
| `field`         | string                          | only for non-`count` | Field to aggregate over.                       |
| `group_by`      | string[]                        | no                   | Group rows by these fields before aggregating. |
| `sysparm_query` | string                          | no                   | Optional encoded query for filtering.          |

Ungrouped responses are returned as a single object; grouped responses as
an array (one entry per group).

### `run_saved_report`

Execute a saved list-type report from `sys_report`.

| Arg             | Type    | Required | Description                        |
| --------------- | ------- | -------- | ---------------------------------- |
| `report_sys_id` | string  | yes      | `sys_id` of a row in `sys_report`. |
| `limit`         | int > 0 | no       | Page size. Default 25.             |
| `offset`        | int ≥ 0 | no       | Row offset for pagination.         |

Returns the records produced by the report plus the report's definition.
v1 supports list reports only.

### `get_user_context`

Return the authenticated user, their roles, and their group memberships.
No inputs.

Returns `{ user: { user_name, sys_id, name, email }, roles: [...], groups: [...] }`.

---

## 6. Resource reference

### `servicenow://tables`

A live JSON catalog of every table visible to the authenticated user
(name, label, super_class, sys_id). Useful for autocompletion and table
discovery without paying for repeated `list_tables` calls.

---

## 7. Troubleshooting

| Symptom                                             | Likely cause / fix                                                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Missing required configuration: SNOW_INSTANCE_URL` | Env var not set or empty. Confirm your shell exports, MCP client `env:` block, or `-e` flag includes the var.               |
| `SNOW_INSTANCE_URL must use https://`               | The server refuses non-HTTPS instances. Use the full `https://...` URL.                                                     |
| `401` / authentication errors from tool calls       | Bearer token expired or user/password incorrect. Rotate the credential.                                                     |
| `404 table not found` from `describe_table`         | Table name is misspelled or the user lacks read ACL on `sys_db_object` for it.                                              |
| `429` or 5xx errors                                 | Transient — the HTTP layer already retries with exponential backoff + jitter. Persistent failures indicate instance health. |
| Tool output blown context budget                    | Reduce `limit`, narrow `fields`, or paginate via `next_offset`.                                                             |
| Client sees no tools after restart                  | Check the client's MCP logs; usually a bad `command`/`args` path or the server crashing on startup.                         |

### Inspecting the server's stderr

When launched by an MCP client, the server's `stderr` is the only place
startup errors surface. Most clients expose this in their MCP server logs
(Claude Desktop: _Settings → Developer → Open MCP Logs_).

### Local smoke test

To confirm credentials work without an MCP client, run the dev server and
let it boot — config validation runs on startup:

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

## Security reminders

- This server is **read-only by design**. Do not patch in mutation
  endpoints; raise a discussion first.
- Credentials live in `process.env`. Never paste them into chat, never
  log them, never include them in error messages, and never commit files
  containing live secret values.
- Validate any client-provided table names, queries, and field lists
  before forwarding to ServiceNow.
