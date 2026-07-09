import { describe, expect, it, vi } from 'vitest';
import { createQueryTableTool } from './query-table.js';
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

describe('query_table tool', () => {
  it('passes inputs to TableApi.query and returns the result envelope', async () => {
    const query = vi.fn(async () => ({ records: [{ sys_id: '1' }], total: 100, next_offset: 1 }));
    const client = {
      table: { query, getRecord: vi.fn() },
      aggregate: { aggregate: vi.fn() },
      attachment: { getAttachment: vi.fn() },
      report: { runSavedReport: vi.fn() },
      userContext: { getUserContext: vi.fn() },
    } as unknown as ServiceNowClient;
    const cache = createResourceCache(DISABLED);
    const tool = createQueryTableTool(client, cache);
    const out = await tool.handler({
      table: 'incident',
      sysparm_query: 'priority=1',
      fields: ['sys_id', 'number'],
      limit: 1,
      offset: 0,
      display_value: 'true',
    });
    expect(query).toHaveBeenCalledWith('incident', {
      sysparmQuery: 'priority=1',
      fields: ['sys_id', 'number'],
      limit: 1,
      offset: 0,
      displayValue: 'true',
    });
    const payload = JSON.parse((out.content?.[0] as { text: string }).text);
    expect(payload).toEqual({ records: [{ sys_id: '1' }], total: 100, next_offset: 1 });
  });
});

describe('query_table tool with cache', () => {
  it('returns the cached result on second call with identical inputs without re-querying', async () => {
    const query = vi.fn(async () => ({ records: [{ sys_id: '1' }] }));
    const client = { table: { query } } as unknown as ServiceNowClient;
    const cache = createResourceCache(ENABLED);
    const tool = createQueryTableTool(client, cache);

    await tool.handler({ table: 'incident', limit: 10 });
    await tool.handler({ table: 'incident', limit: 10 });

    expect(query).toHaveBeenCalledTimes(1);
  });
});
