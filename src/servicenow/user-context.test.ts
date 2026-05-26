import { describe, expect, it, vi } from 'vitest';
import { createUserContextApi } from './user-context.js';
import type { QueryOptions, QueryResult, TableApi } from './table-api.js';

describe('UserContextApi.getUserContext', () => {
  it('resolves user, roles, and groups for the authenticated user', async () => {
    const tableApi: TableApi = {
      query: vi.fn(async (table: string, _opts: QueryOptions): Promise<QueryResult> => {
        if (table === 'sys_user') {
          return {
            records: [
              { sys_id: 'u1', user_name: 'jagaitera', name: 'Jomariel Gaitera', email: 'j@x' },
            ],
            total: 1,
          };
        }
        if (table === 'sys_user_has_role') {
          return {
            records: [
              { role: { value: 'r1', display_value: 'admin' } },
              { role: { value: 'r2', display_value: 'itil' } },
            ],
            total: 2,
          };
        }
        if (table === 'sys_user_grmember') {
          return {
            records: [{ group: { value: 'g1', display_value: 'Network' } }],
            total: 1,
          };
        }
        return { records: [], total: 0 };
      }) as TableApi['query'],
      getRecord: vi.fn(),
    };
    const api = createUserContextApi(tableApi);
    const out = await api.getUserContext();
    expect(out).toEqual({
      sys_id: 'u1',
      user_name: 'jagaitera',
      name: 'Jomariel Gaitera',
      email: 'j@x',
      roles: ['admin', 'itil'],
      groups: ['Network'],
    });
    expect(tableApi.query).toHaveBeenCalledWith(
      'sys_user',
      expect.objectContaining({
        sysparmQuery: 'user_name=javascript:gs.getUser().getName()',
      }),
    );
  });

  it('throws when sys_user lookup returns no rows', async () => {
    const tableApi: TableApi = {
      query: vi.fn(
        async (): Promise<QueryResult> => ({ records: [], total: 0 }),
      ) as TableApi['query'],
      getRecord: vi.fn(),
    };
    const api = createUserContextApi(tableApi);
    await expect(api.getUserContext()).rejects.toThrow();
  });
});
