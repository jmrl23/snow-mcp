import { describe, expect, it, vi } from 'vitest';
import { createTablesResource } from './tables.js';
import type { ServiceNowClient } from '../../servicenow/client.js';

describe('tables resource', () => {
  it('returns ServiceNow tables as a JSON resource', async () => {
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
    const resource = createTablesResource(client);
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
