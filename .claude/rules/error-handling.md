---
paths:
  - "src/**"
---

# Error Handling

- Use typed error classes with codes, not generic `Error("something went wrong")`. Distinguish `ServiceNowAuthError`, `ServiceNowNotFoundError`, `ServiceNowRateLimitError`, etc.
- Never swallow errors silently. Wrap with context (table name, sys_id, operation) before rethrowing.
- Handle every rejected promise. No floating `await`-less async calls.
- MCP tool responses must return structured errors via `isError: true` content blocks, never throw across the MCP boundary uncaught.
- Strip ServiceNow stack traces, server hostnames, and any `Authorization` / `SNOW_*` values from messages before they leave the process.
- Retry transient ServiceNow errors (5xx, 429, ECONNRESET) with exponential backoff and jitter. Fail fast on 4xx auth/validation errors.
- Surface ServiceNow's `X-Total-Count` and pagination headers so callers can handle large result sets without re-querying blindly.
