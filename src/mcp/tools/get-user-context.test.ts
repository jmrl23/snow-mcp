import { describe, expect, it, vi } from 'vitest';
import { createGetUserContextTool } from './get-user-context.js';
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

describe('get_user_context tool', () => {
  it('returns the result of UserContextApi.getUserContext', async () => {
    const getUserContext = vi.fn(async () => ({
      sys_id: 'u1',
      user_name: 'jagaitera',
      name: 'J',
      email: 'j@x',
      roles: ['admin'],
      groups: [],
    }));
    const client = {
      table: { query: vi.fn(), getRecord: vi.fn() },
      aggregate: { aggregate: vi.fn() },
      attachment: { getAttachment: vi.fn() },
      report: { runSavedReport: vi.fn() },
      userContext: { getUserContext },
    } as unknown as ServiceNowClient;
    const cache = createResourceCache(DISABLED);
    const tool = createGetUserContextTool(client, cache);
    const out = await tool.handler({});
    expect(getUserContext).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((out.content?.[0] as { text: string }).text);
    expect(payload.user_name).toBe('jagaitera');
    expect(payload.roles).toEqual(['admin']);
  });
});

describe('get_user_context tool with cache', () => {
  it('returns the cached result on second call without calling getUserContext again', async () => {
    const getUserContext = vi.fn(async () => ({ sys_id: 'u1', user_name: 'jagaitera' }));
    const client = { userContext: { getUserContext } } as unknown as ServiceNowClient;
    const cache = createResourceCache(ENABLED);
    const tool = createGetUserContextTool(client, cache);

    await tool.handler({});
    await tool.handler({});

    expect(getUserContext).toHaveBeenCalledTimes(1);
  });
});
