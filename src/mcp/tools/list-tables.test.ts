import { describe, expect, it, vi } from 'vitest';
import { createListTablesTool } from './list-tables.js';
import type { ServiceNowClient } from '../../servicenow/client.js';

function clientWithTables(records: Record<string, unknown>[]): ServiceNowClient {
  return {
    table: { query: vi.fn(async () => ({ records, total: records.length })), getRecord: vi.fn() },
    aggregate: { aggregate: vi.fn() },
    attachment: { getAttachment: vi.fn() },
    report: { runSavedReport: vi.fn() },
    userContext: { getUserContext: vi.fn() },
  } as unknown as ServiceNowClient;
}

describe('list_tables tool', () => {
  it('returns the full catalog when no filter is provided', async () => {
    const client = clientWithTables([
      { name: 'incident', label: 'Incident', super_class: 'task' },
      { name: 'cmdb_ci', label: 'Configuration Item' },
    ]);
    const tool = createListTablesTool(client);
    const out = await tool.handler({});
    const text = (out.content?.[0] as { text: string }).text;
    expect(text).toContain('"incident"');
    expect(text).toContain('"cmdb_ci"');
  });

  it('filters case-insensitively against name and label', async () => {
    const client = clientWithTables([
      { name: 'incident', label: 'Incident' },
      { name: 'change_request', label: 'Change Request' },
      { name: 'cmdb_ci', label: 'Configuration Item' },
    ]);
    const tool = createListTablesTool(client);
    const out = await tool.handler({ filter: 'CHANGE' });
    const text = (out.content?.[0] as { text: string }).text;
    expect(text).toContain('change_request');
    expect(text).not.toContain('cmdb_ci');
  });
});
