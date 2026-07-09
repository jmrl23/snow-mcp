import { describe, expect, it, vi } from 'vitest';
import { createTablesResource } from './tables.js';
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

function clientWithTables(): { client: ServiceNowClient; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({
    records: [
      { name: 'incident', label: 'Incident', super_class: 'task', sys_id: 'a' },
      { name: 'cmdb_ci', label: 'CI', sys_id: 'b' },
    ],
    total: 2,
  }));
  const client = {
    table: { query, getRecord: vi.fn() },
    aggregate: { aggregate: vi.fn() },
    attachment: { getAttachment: vi.fn() },
    report: { runSavedReport: vi.fn() },
    userContext: { getUserContext: vi.fn() },
  } as unknown as ServiceNowClient;
  return { client, query };
}

describe('tables resource', () => {
  it('returns ServiceNow tables as a JSON resource', async () => {
    const { client } = clientWithTables();
    const cache = createResourceCache(DISABLED);
    const resource = createTablesResource(client, cache);
    const out = await resource.read();
    expect(out.contents).toHaveLength(1);
    expect(out.contents[0]?.uri).toBe('servicenow://tables');
    expect(out.contents[0]?.mimeType).toBe('application/json');
    const payload = JSON.parse(out.contents[0]?.text ?? '');
    expect(payload).toEqual([
      { name: 'incident', label: 'Incident', super_class: 'task', sys_id: 'a' },
      { name: 'cmdb_ci', label: 'CI', sys_id: 'b' },
    ]);
  });
});

describe('tables resource with cache', () => {
  it('returns the cached result on second read without calling client.table.query', async () => {
    const { client, query } = clientWithTables();
    const cache = createResourceCache(ENABLED);
    const resource = createTablesResource(client, cache);

    await resource.read();
    await resource.read();

    expect(query).toHaveBeenCalledTimes(1);
  });
});
