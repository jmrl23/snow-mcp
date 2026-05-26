import type { ServiceNowClient } from '../../servicenow/client.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const getUserContextInput = {} as const;

export interface GetUserContextTool {
  name: 'get_user_context';
  description: string;
  inputShape: typeof getUserContextInput;
  handler(input: Record<string, never>): Promise<McpResult>;
}

export function createGetUserContextTool(client: ServiceNowClient): GetUserContextTool {
  return {
    name: 'get_user_context',
    description:
      'Return the authenticated user (user_name, sys_id, name, email) plus their roles and groups.',
    inputShape: getUserContextInput,
    handler: () => runTool(() => client.userContext.getUserContext()),
  };
}
