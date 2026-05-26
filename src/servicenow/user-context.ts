import type { TableApi } from './table-api.js';

export interface UserContext {
  sys_id: string;
  user_name: string;
  name: string;
  email: string;
  roles: string[];
  groups: string[];
}

export interface UserContextApi {
  getUserContext(): Promise<UserContext>;
}

export function createUserContextApi(tableApi: TableApi): UserContextApi {
  return {
    async getUserContext() {
      const userQ = await tableApi.query('sys_user', {
        sysparmQuery: 'user_name=javascript:gs.getUser().getName()',
        fields: ['sys_id', 'user_name', 'name', 'email'],
        limit: 1,
        displayValue: 'false',
      });
      const u = userQ.records[0];
      if (!u) {
        throw new Error('authenticated user not found in sys_user');
      }
      const userSysId = String(u.sys_id);
      const [rolesQ, groupsQ] = await Promise.all([
        tableApi.query('sys_user_has_role', {
          sysparmQuery: `user=${userSysId}`,
          fields: ['role'],
          limit: 1000,
          displayValue: 'all',
        }),
        tableApi.query('sys_user_grmember', {
          sysparmQuery: `user=${userSysId}`,
          fields: ['group'],
          limit: 1000,
          displayValue: 'all',
        }),
      ]);
      const roles = rolesQ.records
        .map((r) => (r.role as { display_value?: string } | undefined)?.display_value)
        .filter((s): s is string => Boolean(s));
      const groups = groupsQ.records
        .map((r) => (r.group as { display_value?: string } | undefined)?.display_value)
        .filter((s): s is string => Boolean(s));
      return {
        sys_id: userSysId,
        user_name: String(u.user_name ?? ''),
        name: String(u.name ?? ''),
        email: String(u.email ?? ''),
        roles,
        groups,
      };
    },
  };
}
