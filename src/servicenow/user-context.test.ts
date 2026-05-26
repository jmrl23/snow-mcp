import { describe, expect, it, vi } from 'vitest';
import { createUserContextApi } from './user-context.js';
import type { QueryOptions, QueryResult, TableApi } from './table-api.js';

function buildTableApi(fn: (table: string, opts: QueryOptions) => Promise<QueryResult>): TableApi {
  return {
    query: vi.fn(fn) as TableApi['query'],
    getRecord: vi.fn(),
  };
}

const fullPopulatedQuery = async (table: string): Promise<QueryResult> => {
  if (table === 'sys_user') {
    return {
      records: [{ sys_id: 'u1', user_name: 'jagaitera', name: 'Jomariel Gaitera', email: 'j@x' }],
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
};

describe('UserContextApi.getUserContext', () => {
  it('resolves user, roles, and groups for the authenticated user via script-eval fallback', async () => {
    const tableApi = buildTableApi(fullPopulatedQuery);
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
  });

  it('uses the script-eval filter when no authenticatedUserName hint is given', async () => {
    const tableApi = buildTableApi(fullPopulatedQuery);
    const api = createUserContextApi(tableApi);
    await api.getUserContext();
    expect(tableApi.query).toHaveBeenCalledWith(
      'sys_user',
      expect.objectContaining({
        sysparmQuery: 'user_name=javascript:gs.getUser().getName()',
      }),
    );
  });

  it('queries sys_user by the supplied authenticatedUserName when provided', async () => {
    const tableApi = buildTableApi(fullPopulatedQuery);
    const api = createUserContextApi(tableApi, { authenticatedUserName: 'jagaitera' });
    await api.getUserContext();
    expect(tableApi.query).toHaveBeenCalledWith(
      'sys_user',
      expect.objectContaining({ sysparmQuery: 'user_name=jagaitera' }),
    );
  });

  it('throws ConfigError when sys_user lookup returns no rows', async () => {
    const tableApi = buildTableApi(async () => ({ records: [], total: 0 }));
    const api = createUserContextApi(tableApi);
    await expect(api.getUserContext()).rejects.toThrow(/authenticated user not found/);
  });

  it('throws ConfigError when sys_user returns a phantom row with empty user_name', async () => {
    const tableApi = buildTableApi(async () => ({
      records: [{ sys_id: 'phantom', user_name: '', name: '', email: '' }],
      total: 1,
    }));
    const api = createUserContextApi(tableApi);
    await expect(api.getUserContext()).rejects.toThrow(/SNOW_AUTHENTICATED_USER/);
  });
});
