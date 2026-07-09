import type { ServiceNowClient } from '../../servicenow/client.js';
import type { ResourceCache } from '../../cache/resource-cache.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const getUserContextInput = {} as const;

const CACHE_KEY = 'get_user_context:singleton';

export interface GetUserContextTool {
  name: 'get_user_context';
  description: string;
  inputShape: typeof getUserContextInput;
  handler(input: Record<string, never>): Promise<McpResult>;
}

export function createGetUserContextTool(
  client: ServiceNowClient,
  cache: ResourceCache,
): GetUserContextTool {
  return {
    name: 'get_user_context',
    description:
      'Return the authenticated user (user_name, sys_id, name, email) plus their roles and groups.',
    inputShape: getUserContextInput,
    handler: () =>
      runTool(async () => {
        const cached = await cache.get('user_context', CACHE_KEY);
        if (cached !== undefined) return cached;
        const out = await client.userContext.getUserContext();
        await cache.set('user_context', CACHE_KEY, out);
        return out;
      }),
  };
}
