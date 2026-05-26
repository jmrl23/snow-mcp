# snow-mcp

Read-only MCP server exposing a ServiceNow instance to MCP clients. TypeScript, ESM, Node 24.

## Commands

```bash
yarn dev                    # tsx watch on src/main.ts
yarn build                  # tsc → dist/
yarn start                  # node dist/main.js
yarn typecheck              # tsc --noEmit
yarn lint                   # eslint
yarn format                 # prettier --write
yarn test                   # vitest run
yarn test src/foo.test.ts   # single file
```

## Key Decisions

- **Read-only only.** No write/update/delete calls to the ServiceNow API. If a feature needs mutation, surface it as a discussion before coding.
- **Credentials live in `.env`** — instance URL, user/password, static bearer token (`SNOW_OAUTH_TOKEN`), and OAuth client_credentials (`SNOW_OAUTH_CLIENT_ID` + `SNOW_OAUTH_CLIENT_SECRET`). Never log them, never echo them in error messages, never commit them. Auth selection is implicit by env presence; priority is `client_credentials > token > basic`.
- **MCP transport:** both `stdio` (default) and `http` (Streamable HTTP) are first-class and live in `src/mcp/transport/`. Selected by `MCP_TRANSPORT`.

## Don'ts

- Don't add ServiceNow write operations (POST/PUT/PATCH/DELETE on `/api/now/table/*`).
- Don't read or commit `.env` (live secrets — gitignored and hook-blocked). `.env.example` is committed intentionally; keep it in sync when new env vars are added.
