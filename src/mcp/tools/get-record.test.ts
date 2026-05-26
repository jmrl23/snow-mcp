import { describe, expect, it, vi } from 'vitest';
import { createGetRecordTool } from './get-record.js';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { ServiceNowNotFoundError } from '../../errors.js';

describe('get_record tool', () => {
  it('returns the record from TableApi.getRecord', async () => {
    const getRecord = vi.fn(async () => ({ sys_id: 'abc', number: 'INC1' }));
    const client = {
      table: { query: vi.fn(), getRecord },
      aggregate: { aggregate: vi.fn() },
      attachment: { getAttachment: vi.fn() },
      report: { runSavedReport: vi.fn() },
      userContext: { getUserContext: vi.fn() },
    } as unknown as ServiceNowClient;
    const tool = createGetRecordTool(client);
    const out = await tool.handler({
      table: 'incident',
      sys_id: 'abc',
      fields: ['sys_id', 'number'],
    });
    expect(getRecord).toHaveBeenCalledWith('incident', 'abc', ['sys_id', 'number']);
    expect(JSON.parse((out.content?.[0] as { text: string }).text)).toEqual({
      sys_id: 'abc',
      number: 'INC1',
    });
  });

  it('forwards ServiceNowNotFoundError as not_found', async () => {
    const getRecord = vi.fn(async () => {
      throw new ServiceNowNotFoundError(404, null, 'gone');
    });
    const client = {
      table: { query: vi.fn(), getRecord },
      aggregate: { aggregate: vi.fn() },
      attachment: { getAttachment: vi.fn() },
      report: { runSavedReport: vi.fn() },
      userContext: { getUserContext: vi.fn() },
    } as unknown as ServiceNowClient;
    const tool = createGetRecordTool(client);
    const out = await tool.handler({ table: 'incident', sys_id: 'missing' });
    expect(out.isError).toBe(true);
    expect((out.content?.[0] as { text: string }).text).toContain('not_found');
  });
});
