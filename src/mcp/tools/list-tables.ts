import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const listTablesInput = {
  filter: z
    .string()
    .optional()
    .describe('Case-insensitive substring matched against table name and label.'),
};

export interface ListTablesTool {
  name: 'list_tables';
  description: string;
  inputShape: typeof listTablesInput;
  handler(input: { filter?: string }): Promise<McpResult>;
}

export function createListTablesTool(client: ServiceNowClient): ListTablesTool {
  return {
    name: 'list_tables',
    description:
      'List ServiceNow tables visible to the authenticated user. Use the optional `filter` arg to narrow by name or label.',
    inputShape: listTablesInput,
    handler: (input) =>
      runTool(async () => {
        const out = await client.table.query<{
          name: string;
          label: string;
          super_class?: string;
          sys_id: string;
        }>('sys_db_object', {
          fields: ['name', 'label', 'super_class', 'sys_id'],
          limit: 10000,
          offset: 0,
        });
        const f = input.filter?.toLowerCase();
        const rows = f
          ? out.records.filter(
              (r) => r.name?.toLowerCase().includes(f) || r.label?.toLowerCase().includes(f),
            )
          : out.records;
        return rows.map(({ name, label, super_class }) => ({ name, label, super_class }));
      }),
  };
}
