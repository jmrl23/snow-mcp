import { describe, expect, it, vi } from 'vitest';
import { createDescribeTableTool } from './describe-table.js';
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

function buildClient(): { client: ServiceNowClient; query: ReturnType<typeof vi.fn> } {
  // NOTE: filters on sysparmQuery so the "unknown table" test actually exercises the
  // not_found path instead of always matching the canned "incident" row.
  const query = vi.fn(async (table: string, opts?: { sysparmQuery?: string }) => {
    if (table === 'sys_db_object') {
      if (opts?.sysparmQuery !== 'name=incident') {
        return { records: [], total: 0 };
      }
      return {
        records: [{ name: 'incident', label: 'Incident', super_class: { display_value: 'task' } }],
        total: 1,
      };
    }
    if (table === 'sys_dictionary') {
      if (!opts?.sysparmQuery?.startsWith('name=incident')) {
        return { records: [], total: 0 };
      }
      return {
        records: [
          {
            element: 'number',
            column_label: 'Number',
            internal_type: { value: 'string' },
            mandatory: 'true',
            read_only: 'true',
          },
          {
            element: 'caller_id',
            column_label: 'Caller',
            internal_type: { value: 'reference' },
            reference: { value: 'sys_user' },
            mandatory: 'false',
            read_only: 'false',
          },
        ],
        total: 2,
      };
    }
    return { records: [], total: 0 };
  });
  const client = {
    table: { query, getRecord: vi.fn() },
    aggregate: { aggregate: vi.fn() },
    attachment: { getAttachment: vi.fn() },
    report: { runSavedReport: vi.fn() },
    userContext: { getUserContext: vi.fn() },
  } as unknown as ServiceNowClient;
  return { client, query };
}

describe('describe_table tool', () => {
  it('returns table metadata plus normalised fields', async () => {
    const { client } = buildClient();
    const cache = createResourceCache(DISABLED);
    const tool = createDescribeTableTool(client, cache);
    const out = await tool.handler({ name: 'incident' });
    const payload = JSON.parse((out.content?.[0] as { text: string }).text);
    expect(payload.name).toBe('incident');
    expect(payload.label).toBe('Incident');
    expect(payload.parent).toBe('task');
    expect(payload.fields).toEqual([
      {
        name: 'number',
        label: 'Number',
        type: 'string',
        reference: undefined,
        mandatory: true,
        readOnly: true,
      },
      {
        name: 'caller_id',
        label: 'Caller',
        type: 'reference',
        reference: 'sys_user',
        mandatory: false,
        readOnly: false,
      },
    ]);
  });

  it('emits a not_found error when the table is unknown', async () => {
    const { client } = buildClient();
    const cache = createResourceCache(DISABLED);
    const tool = createDescribeTableTool(client, cache);
    const out = await tool.handler({ name: 'nope' });
    expect(out.isError).toBe(true);
    expect((out.content?.[0] as { text: string }).text).toContain('not_found');
  });
});

describe('createDescribeTableTool with cache', () => {
  it('returns the cached result on second invocation without calling client.table.query', async () => {
    const { client, query } = buildClient();
    const cache = createResourceCache(ENABLED);
    const tool = createDescribeTableTool(client, cache);

    const first = await tool.handler({ name: 'incident' });
    const second = await tool.handler({ name: 'incident' });

    expect(query).toHaveBeenCalledTimes(2); // first call hits sys_db_object + sys_dictionary
    expect(second).toEqual(first);
  });

  it('hits the client every call when the cache is disabled', async () => {
    const { client, query } = buildClient();
    const cache = createResourceCache(DISABLED);
    const tool = createDescribeTableTool(client, cache);

    await tool.handler({ name: 'incident' });
    await tool.handler({ name: 'incident' });

    expect(query.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});
