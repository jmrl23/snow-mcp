import { describe, expect, it, vi } from 'vitest';
import { createGetUserContextTool } from './get-user-context.js';
import type { ServiceNowClient } from '../../servicenow/client.js';

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
    const tool = createGetUserContextTool(client);
    const out = await tool.handler({});
    expect(getUserContext).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((out.content?.[0] as { text: string }).text);
    expect(payload.user_name).toBe('jagaitera');
    expect(payload.roles).toEqual(['admin']);
  });
});
