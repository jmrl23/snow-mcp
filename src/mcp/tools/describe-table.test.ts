import { describe, expect, it, vi } from 'vitest';
import { createDescribeTableTool } from './describe-table.js';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { createSchemaCache } from '../../servicenow/schema-cache.js';

function buildClient(): { client: ServiceNowClient; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (table: string) => {
    if (table === 'sys_db_object') {
      return {
        records: [{ name: 'incident', label: 'Incident', super_class: { display_value: 'task' } }],
        total: 1,
      };
    }
    if (table === 'sys_dictionary') {
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
    const cache = createSchemaCache<unknown>({ ttlMs: 0, maxEntries: 0 }); // disabled
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
    const client = {
      table: { query: vi.fn(async () => ({ records: [], total: 0 })), getRecord: vi.fn() },
      aggregate: { aggregate: vi.fn() },
      attachment: { getAttachment: vi.fn() },
      report: { runSavedReport: vi.fn() },
      userContext: { getUserContext: vi.fn() },
    } as unknown as ServiceNowClient;
    const cache = createSchemaCache<unknown>({ ttlMs: 0, maxEntries: 0 }); // disabled
    const tool = createDescribeTableTool(client, cache);
    const out = await tool.handler({ name: 'nope' });
    expect(out.isError).toBe(true);
    expect((out.content?.[0] as { text: string }).text).toContain('not_found');
  });
});

describe('createDescribeTableTool with cache', () => {
  it('returns the cached result on second invocation without calling client.table.query', async () => {
    const queries: { table: string }[] = [];
    const client = {
      table: {
        async query(table: string) {
          queries.push({ table });
          if (table === 'sys_db_object') {
            return { records: [{ name: 'incident', label: 'Incident', super_class: null }] };
          }
          if (table === 'sys_dictionary') {
            return {
              records: [
                {
                  element: 'number',
                  column_label: 'Number',
                  internal_type: { value: 'string' },
                  mandatory: 'false',
                  read_only: 'true',
                },
              ],
            };
          }
          return { records: [] };
        },
      },
    } as unknown as ServiceNowClient;
    const cache = createSchemaCache<unknown>({ ttlMs: 60_000, maxEntries: 10 });
    const tool = createDescribeTableTool(client, cache);

    const first = await tool.handler({ name: 'incident' });
    const second = await tool.handler({ name: 'incident' });

    expect(queries).toHaveLength(2); // first call hits sys_db_object + sys_dictionary
    expect(second).toEqual(first);
  });

  it('hits the client every call when the cache is disabled (ttlMs: 0)', async () => {
    const queries: { table: string }[] = [];
    const client = {
      table: {
        async query(table: string) {
          queries.push({ table });
          if (table === 'sys_db_object') {
            return { records: [{ name: 'incident', label: 'Incident', super_class: null }] };
          }
          return { records: [] };
        },
      },
    } as unknown as ServiceNowClient;
    const cache = createSchemaCache<unknown>({ ttlMs: 0, maxEntries: 10 }); // disabled
    const tool = createDescribeTableTool(client, cache);

    await tool.handler({ name: 'incident' });
    await tool.handler({ name: 'incident' });

    expect(queries.length).toBeGreaterThanOrEqual(4);
  });
});
