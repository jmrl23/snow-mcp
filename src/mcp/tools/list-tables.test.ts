import { describe, expect, it, vi } from 'vitest';
import { createListTablesTool } from './list-tables.js';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { createResourceCache } from '../../cache/resource-cache.js';

const DISABLED = {
  dbPath: ':memory:',
  ttlLongMs: 0,
  ttlMediumMs: 0,
  ttlShortMs: 0,
  maxEntries: 10,
};
const ENABLED = {
  dbPath: ':memory:',
  ttlLongMs: 60_000,
  ttlMediumMs: 60_000,
  ttlShortMs: 60_000,
  maxEntries: 10,
};

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
    const cache = createResourceCache(DISABLED);
    const tool = createListTablesTool(client, cache);
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
    const cache = createResourceCache(DISABLED);
    const tool = createListTablesTool(client, cache);
    const out = await tool.handler({ filter: 'CHANGE' });
    const text = (out.content?.[0] as { text: string }).text;
    expect(text).toContain('change_request');
    expect(text).not.toContain('cmdb_ci');
  });
});

describe('createListTablesTool with cache', () => {
  it('caches the full table list and applies filter on the cached result', async () => {
    const query = vi.fn(async () => ({
      records: [
        { name: 'incident', label: 'Incident', super_class: 'task', sys_id: 'a' },
        { name: 'change_request', label: 'Change Request', super_class: 'task', sys_id: 'b' },
      ],
    }));
    const client = { table: { query } } as unknown as ServiceNowClient;
    const cache = createResourceCache(ENABLED);
    const tool = createListTablesTool(client, cache);

    await tool.handler({});
    await tool.handler({ filter: 'incident' });

    expect(query).toHaveBeenCalledTimes(1);
  });
});
