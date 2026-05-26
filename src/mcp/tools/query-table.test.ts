import { describe, expect, it, vi } from 'vitest';
import { createQueryTableTool } from './query-table.js';
import type { ServiceNowClient } from '../../servicenow/client.js';

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
    const tool = createQueryTableTool(client);
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
