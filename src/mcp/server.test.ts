import { describe, expect, it, vi } from 'vitest';
import { createMcpServer } from './server.js';
import type { ServiceNowClient } from '../servicenow/client.js';

function fakeClient(): ServiceNowClient {
  return {
    table: { query: vi.fn(async () => ({ records: [], total: 0 })), getRecord: vi.fn() },
    aggregate: { aggregate: vi.fn() },
    attachment: { getAttachment: vi.fn() },
    report: { runSavedReport: vi.fn() },
    userContext: { getUserContext: vi.fn() },
  } as unknown as ServiceNowClient;
}

describe('createMcpServer', () => {
  it('registers the 8 tools and the tables resource', () => {
    const server = createMcpServer(fakeClient());
    // McpServer exposes lower-level Server via .server. We just confirm it built.
    expect(server.server).toBeDefined();
    // Indirect check: introspect registered tools via the internal map (test-only access).
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(tools).sort()).toEqual(
      [
        'aggregate',
        'describe_table',
        'get_attachment',
        'get_record',
        'get_user_context',
        'list_tables',
        'query_table',
        'run_saved_report',
      ].sort(),
    );
    const resources = (
      server as unknown as { _registeredResources: Record<string, { name: string }> }
    )._registeredResources;
    expect(Object.values(resources).map((r) => r.name)).toContain('tables');
  });
});
