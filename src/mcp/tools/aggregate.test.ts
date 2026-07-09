import { describe, expect, it, vi } from 'vitest';
import { createAggregateTool } from './aggregate.js';
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
    const cache = createResourceCache(DISABLED);
    const tool = createAggregateTool(client, cache);
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
    const cache = createResourceCache(DISABLED);
    const tool = createAggregateTool(client, cache);
    const out = await tool.handler({ table: 'incident', operation: 'sum' });
    expect(out.isError).toBe(true);
    expect((out.content?.[0] as { text: string }).text).toContain('internal_error');
  });
});

describe('aggregate tool with cache', () => {
  it('returns the cached result on second call with identical inputs without re-aggregating', async () => {
    const aggregate = vi.fn(async () => [{ value: 42 }]);
    const client = { aggregate: { aggregate } } as unknown as ServiceNowClient;
    const cache = createResourceCache(ENABLED);
    const tool = createAggregateTool(client, cache);

    await tool.handler({ table: 'incident', operation: 'count' });
    await tool.handler({ table: 'incident', operation: 'count' });

    expect(aggregate).toHaveBeenCalledTimes(1);
  });
});
