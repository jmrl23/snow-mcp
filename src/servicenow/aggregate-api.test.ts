import { describe, expect, it, vi } from 'vitest';
import { createAggregateApi } from './aggregate-api.js';
import type { HttpClient } from '../http/client.js';

function mockClient(body: unknown): {
  client: HttpClient;
  calls: Array<{ path: string; query?: Record<string, string | undefined> }>;
} {
  const calls: Array<{ path: string; query?: Record<string, string | undefined> }> = [];
  const client: HttpClient = {
    request: vi.fn(async (path: string, opts) => {
      calls.push({ path, query: opts?.query });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
    requestRaw: vi.fn(),
  };
  return { client, calls };
}

describe('AggregateApi.aggregate', () => {
  it('GETs /api/now/stats/<table> with count when operation=count', async () => {
    const { client, calls } = mockClient({ result: [{ stats: { count: '42' } }] });
    const api = createAggregateApi(client);
    const out = await api.aggregate('incident', { operation: 'count' });
    expect(calls[0]?.path).toBe('/api/now/stats/incident');
    expect(calls[0]?.query?.sysparm_count).toBe('true');
    expect(out).toEqual([{ group: {}, value: 42 }]);
  });

  it('passes sysparm_group_by and sysparm_avg_fields when operation=avg with grouping', async () => {
    const { client, calls } = mockClient({
      result: [
        {
          groupby_fields: [{ field: 'priority', value: '1' }],
          stats: { avg: { duration: '120' } },
        },
        {
          groupby_fields: [{ field: 'priority', value: '2' }],
          stats: { avg: { duration: '200' } },
        },
      ],
    });
    const api = createAggregateApi(client);
    const out = await api.aggregate('incident', {
      operation: 'avg',
      field: 'duration',
      groupBy: ['priority'],
      sysparmQuery: 'active=true',
    });
    expect(calls[0]?.query?.sysparm_group_by).toBe('priority');
    expect(calls[0]?.query?.sysparm_avg_fields).toBe('duration');
    expect(calls[0]?.query?.sysparm_query).toBe('active=true');
    expect(out).toEqual([
      { group: { priority: '1' }, value: 120 },
      { group: { priority: '2' }, value: 200 },
    ]);
  });

  it('throws when a non-count operation is missing a field', async () => {
    const { client } = mockClient({ result: [] });
    const api = createAggregateApi(client);
    await expect(api.aggregate('incident', { operation: 'sum' })).rejects.toThrow(/field/);
  });

  it('handles non-grouped count where ServiceNow returns a single object, not an array', async () => {
    // Live ServiceNow returns `{ result: { stats: { count: '7' } } }` for an
    // ungrouped count call. The wrapper must normalise that to a single-row array.
    const { client } = mockClient({ result: { stats: { count: '7' } } });
    const api = createAggregateApi(client);
    const out = await api.aggregate('incident', { operation: 'count' });
    expect(out).toEqual([{ group: {}, value: 7 }]);
  });

  it('handles a missing/empty result field without crashing', async () => {
    const { client } = mockClient({});
    const api = createAggregateApi(client);
    const out = await api.aggregate('incident', { operation: 'count' });
    expect(out).toEqual([]);
  });
});
