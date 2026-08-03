import { describe, expect, it, vi } from 'vitest';
import { createAggregateTool } from './aggregate.js';
import type { ServiceNowClient } from '../../servicenow/client.js';

describe('aggregate tool', () => {
  it('forwards inputs to AggregateApi.aggregate', async () => {
    const aggregate = vi.fn(async () => [{ group: { priority: '1' }, value: 42 }]);
    const client = {
      table: { query: vi.fn(), getRecord: vi.fn() },
      aggregate: { aggregate },
      attachment: { getAttachment: vi.fn() },
      report: { runSavedReport: vi.fn() },
      userContext: { getUserContext: vi.fn() },
    } as unknown as ServiceNowClient;
    const tool = createAggregateTool(client);
    const out = await tool.handler({
      table: 'incident',
      operation: 'count',
      group_by: ['priority'],
      sysparm_query: 'active=true',
    });
    expect(aggregate).toHaveBeenCalledWith('incident', {
      operation: 'count',
      field: undefined,
      groupBy: ['priority'],
      sysparmQuery: 'active=true',
    });
    expect(JSON.parse((out.content?.[0] as { text: string }).text)).toEqual([
      { group: { priority: '1' }, value: 42 },
    ]);
  });

  it('emits client_error when API throws for non-count without field', async () => {
    const aggregate = vi.fn(async () => {
      throw new Error('field required');
    });
    const client = {
      table: { query: vi.fn(), getRecord: vi.fn() },
      aggregate: { aggregate },
      attachment: { getAttachment: vi.fn() },
      report: { runSavedReport: vi.fn() },
      userContext: { getUserContext: vi.fn() },
    } as unknown as ServiceNowClient;
    const tool = createAggregateTool(client);
    const out = await tool.handler({ table: 'incident', operation: 'sum' });
    expect(out.isError).toBe(true);
    expect((out.content?.[0] as { text: string }).text).toContain('internal_error');
  });
});
