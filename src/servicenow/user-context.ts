import type { TableApi } from './table-api.js';
import { ConfigError } from '../errors.js';

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

export interface UserContextOptions {
  /**
   * Known user_name of the authenticated principal. When set, the lookup
   * filters sys_user by this value directly. Without it, the lookup falls
   * back to `user_name=javascript:gs.getUser().getName()`, which only
   * resolves for users that have the `client_callable_script_include`
   * privilege — others get a phantom empty row.
   */
  authenticatedUserName?: string;
}

export function createUserContextApi(
  tableApi: TableApi,
  options: UserContextOptions = {},
): UserContextApi {
  return {
    async getUserContext() {
      const filterByName = options.authenticatedUserName;
      const userQ = await tableApi.query('sys_user', {
        sysparmQuery: filterByName
          ? `user_name=${filterByName}`
          : 'user_name=javascript:gs.getUser().getName()',
        fields: ['sys_id', 'user_name', 'name', 'email'],
        limit: 1,
        displayValue: 'false',
      });
      const u = userQ.records[0];
      if (!u) {
        throw new ConfigError(
          filterByName
            ? `authenticated user not found in sys_user: user_name=${filterByName}`
            : 'authenticated user not found in sys_user',
        );
      }
      if (!u.user_name) {
        throw new ConfigError(
          'Unable to identify the authenticated user: the sys_user lookup returned ' +
            'a row with an empty user_name. This usually means the ServiceNow account ' +
            'lacks the script-evaluation privilege required for the default lookup. ' +
            'Set SNOW_AUTHENTICATED_USER to the exact user_name of the account this ' +
            'process authenticates as.',
        );
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
