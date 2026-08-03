import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { runTool, type McpResult } from '../tool-helpers.js';
import { ServiceNowNotFoundError } from '../../errors.js';

export const describeTableInput = {
  name: z.string().describe('Table name (e.g. "incident", "cmdb_ci").'),
};

export interface DescribeTableTool {
  name: 'describe_table';
  description: string;
  inputShape: typeof describeTableInput;
  handler(input: { name: string }): Promise<McpResult>;
}

export function createDescribeTableTool(client: ServiceNowClient): DescribeTableTool {
  return {
    name: 'describe_table',
    description:
      'Describe a ServiceNow table: label, parent table, and field definitions (from sys_dictionary).',
    inputShape: describeTableInput,
    handler: (input) =>
      runTool(async () => {
        const meta = await client.table.query<{
          name: string;
          label: string;
          super_class?: { display_value?: string };
        }>('sys_db_object', {
          sysparmQuery: `name=${input.name}`,
          fields: ['name', 'label', 'super_class'],
          limit: 1,
          displayValue: 'all',
        });
        const row = meta.records[0];
        if (!row) {
          throw new ServiceNowNotFoundError(
            404,
            { table: input.name },
            `table not found: ${input.name}`,
          );
        }
        const dict = await client.table.query<{
          element: string;
          column_label: string;
          internal_type?: { value?: string };
          reference?: { value?: string };
          mandatory: string;
          read_only: string;
        }>('sys_dictionary', {
          sysparmQuery: `name=${input.name}^elementISNOTEMPTY`,
          fields: [
            'element',
            'column_label',
            'internal_type',
            'reference',
            'mandatory',
            'read_only',
          ],
          limit: 1000,
          displayValue: 'all',
        });
        return {
          name: row.name,
          label: row.label,
          parent: row.super_class?.display_value ?? null,
          fields: dict.records.map((f) => ({
            name: f.element,
            label: f.column_label,
            type: f.internal_type?.value ?? 'unknown',
            reference: f.reference?.value || undefined,
            mandatory: f.mandatory === 'true',
            readOnly: f.read_only === 'true',
          })),
        };
      }),
  };
}
