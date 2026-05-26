---
paths:
  - "src/**"
---

# Security

- ServiceNow credentials live in `.env` (`SNOW_INSTANCE_URL`, `SNOW_USER`, `SNOW_PASSWORD`, `SNOW_OAUTH_TOKEN`, `SNOW_OAUTH_CLIENT_ID`, `SNOW_OAUTH_CLIENT_SECRET`). Read them only via `process.env`. Never hardcode, never log, never include in error messages or thrown errors.
- This server is read-only. Refuse to add code that issues `POST`, `PUT`, `PATCH`, or `DELETE` against the ServiceNow REST API (`/api/now/table/*`, `/api/now/import/*`, attachment uploads, etc.). If a feature seems to need mutation, stop and surface it.
- Validate every value coming from an MCP client before forwarding it into a ServiceNow query. Allow-list table names, encoded queries, and field names; reject anything else.
- Never interpolate client input directly into `sysparm_query` strings without escaping. Use parameter objects passed to the HTTP client.
- HTTPS only when talking to ServiceNow. Reject `http://` instance URLs at startup.
- Use constant-time comparison for any secret or token check.
- Redact `Authorization`, cookies, and any `SNOW_*` env values before logging request/response objects.
