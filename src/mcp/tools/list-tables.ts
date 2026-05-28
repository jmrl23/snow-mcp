import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
import type { SchemaCache } from '../../servicenow/schema-cache.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const listTablesInput = {
  filter: z
    .string()
    .optional()
    .describe('Case-insensitive substring matched against table name and label.'),
};

export interface CachedRow {
  name: string;
  label: string;
  super_class?: string;
}

const ALL_KEY = '__all__';

export interface ListTablesTool {
  name: 'list_tables';
  description: string;
  inputShape: typeof listTablesInput;
  handler(input: { filter?: string }): Promise<McpResult>;
}

export function createListTablesTool(
  client: ServiceNowClient,
  cache: SchemaCache<CachedRow[]>,
): ListTablesTool {
  return {
    name: 'list_tables',
    description:
      'List ServiceNow tables visible to the authenticated user. Use the optional `filter` arg to narrow by name or label.',
    inputShape: listTablesInput,
    handler: (input) =>
      runTool(async () => {
        let rows = await cache.get(ALL_KEY);
        if (!rows) {
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
          rows = out.records.map(({ name, label, super_class }) => ({ name, label, super_class }));
          await cache.set(ALL_KEY, rows);
        }
        const f = input.filter?.toLowerCase();
        return f
          ? rows.filter(
              (r) => r.name?.toLowerCase().includes(f) || r.label?.toLowerCase().includes(f),
            )
          : rows;
      }),
  };
}
