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
- **Credentials live in `.env`** (instance URL, user, password / OAuth token). Never log them, never echo them in error messages, never commit them.
- **MCP transport:** use `@modelcontextprotocol/sdk` stdio transport unless the user explicitly requests HTTP.

## Don'ts

- Don't add ServiceNow write operations (POST/PUT/PATCH/DELETE on `/api/now/table/*`).
- Don't read or commit `.env`. It's also blocked by hooks.
