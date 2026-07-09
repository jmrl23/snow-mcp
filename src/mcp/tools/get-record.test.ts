import { describe, expect, it, vi } from 'vitest';
import { createGetRecordTool } from './get-record.js';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { ServiceNowNotFoundError } from '../../errors.js';
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
    const cache = createResourceCache(DISABLED);
    const tool = createGetRecordTool(client, cache);
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
    const cache = createResourceCache(DISABLED);
    const tool = createGetRecordTool(client, cache);
    const out = await tool.handler({ table: 'incident', sys_id: 'missing' });
    expect(out.isError).toBe(true);
    expect((out.content?.[0] as { text: string }).text).toContain('not_found');
  });
});

describe('get_record tool with cache', () => {
  it('returns the cached result on second call without calling getRecord again', async () => {
    const getRecord = vi.fn(async () => ({ sys_id: 'abc', number: 'INC1' }));
    const client = {
      table: { query: vi.fn(), getRecord },
      aggregate: { aggregate: vi.fn() },
      attachment: { getAttachment: vi.fn() },
      report: { runSavedReport: vi.fn() },
      userContext: { getUserContext: vi.fn() },
    } as unknown as ServiceNowClient;
    const cache = createResourceCache(ENABLED);
    const tool = createGetRecordTool(client, cache);

    await tool.handler({ table: 'incident', sys_id: 'abc' });
    await tool.handler({ table: 'incident', sys_id: 'abc' });

    expect(getRecord).toHaveBeenCalledTimes(1);
  });
});
