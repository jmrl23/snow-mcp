---
alwaysApply: true
---

# Testing

- Framework: **Vitest**. Tests live next to source as `*.test.ts` under `src/`. Run one file: `yarn test src/foo.test.ts`.
- Verify behavior, not implementation. Don't assert mock call counts when output values would do.
- Run the specific test file after changes, not the full suite. Faster feedback, fewer tokens.
- Flaky test? Fix it or delete it. Never retry to make it pass.
- Mock only at system boundaries — the ServiceNow HTTP layer is the boundary here. Use `vi.mock` or an injected fetch; never hit a real instance from unit tests.
- Never log or commit real ServiceNow credentials in fixtures. Use obviously fake values (`https://example.service-now.com`, `test-user`).
- One assertion per test. Test names describe behavior. Arrange-Act-Assert. No `if` or loops in tests.
- Never `expect(true)` or check a mock was called without verifying arguments.
