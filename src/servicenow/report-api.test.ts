import { describe, expect, it, vi } from 'vitest';
import { createReportApi } from './report-api.js';
import type { QueryOptions, QueryResult, TableApi } from './table-api.js';

function fakeTableApi(records: Record<string, unknown>): TableApi {
  return {
    query: vi.fn(
      async <T = Record<string, unknown>>(
        _table: string,
        _opts: QueryOptions,
      ): Promise<QueryResult<T>> => ({
        records: (records[_table] as T[]) ?? [],
        total: (records[_table] as unknown[])?.length,
      }),
    ) as TableApi['query'],
    getRecord: vi.fn(
      async <T = Record<string, unknown>>(_table: string, sysId: string): Promise<T> => {
        const arr = records[_table] as Record<string, unknown>[];
        return arr.find((r) => r.sys_id === sysId) as T;
      },
    ) as TableApi['getRecord'],
  };
}

describe('ReportApi.runSavedReport', () => {
  it('loads a list-type report, derives the query, and executes via TableApi', async () => {
    const tableApi = fakeTableApi({
      sys_report: [
        {
          sys_id: 'rep1',
          type: 'list',
          table: 'incident',
          filter: 'priority=1',
          field_list: 'number,short_description',
        },
      ],
      incident: [
        { sys_id: 'i1', number: 'INC1' },
        { sys_id: 'i2', number: 'INC2' },
      ],
    });
    const api = createReportApi(tableApi);
    const out = await api.runSavedReport('rep1', { limit: 25, offset: 0 });
    expect(out.definition).toEqual({ table: 'incident', columns: ['number', 'short_description'] });
    expect(out.records).toHaveLength(2);
    expect(tableApi.query).toHaveBeenCalledWith(
      'incident',
      expect.objectContaining({
        sysparmQuery: 'priority=1',
        fields: ['number', 'short_description'],
        limit: 25,
        offset: 0,
      }),
    );
  });

  it('returns unsupported_report_type error for non-list reports', async () => {
    const tableApi = fakeTableApi({
      sys_report: [{ sys_id: 'rep2', type: 'pie', table: 'incident', filter: '' }],
    });
    const api = createReportApi(tableApi);
    await expect(api.runSavedReport('rep2', {})).rejects.toThrow(/unsupported_report_type/);
  });

  it('throws when the report sys_id does not exist', async () => {
    const tableApi: TableApi = {
      query: vi.fn(
        async <T = Record<string, unknown>>(): Promise<QueryResult<T>> => ({
          records: [],
          total: 0,
        }),
      ) as TableApi['query'],
      getRecord: vi.fn(async <T = Record<string, unknown>>(): Promise<T> => {
        throw new Error('404 not found');
      }) as TableApi['getRecord'],
    };
    const api = createReportApi(tableApi);
    await expect(api.runSavedReport('missing', {})).rejects.toThrow();
  });
});
