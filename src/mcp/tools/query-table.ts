import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const queryTableInput = {
  table: z.string().describe('ServiceNow table name (e.g. "incident").'),
  sysparm_query: z
    .string()
    .optional()
    .describe('Encoded query string (ServiceNow syntax, e.g. "priority=1^stateIN1,2").'),
  fields: z
    .array(z.string())
    .optional()
    .describe('Field allowlist. Omit to return all readable fields.'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Max rows in this page. Default 25. Large values inflate context cost.'),
  offset: z.number().int().nonnegative().optional().describe('Row offset for pagination.'),
  display_value: z
    .enum(['true', 'false', 'all'])
    .optional()
    .describe('ServiceNow display-value mode.'),
};

type Input = {
  table: string;
  sysparm_query?: string;
  fields?: string[];
  limit?: number;
  offset?: number;
  display_value?: 'true' | 'false' | 'all';
};

export interface QueryTableTool {
  name: 'query_table';
  description: string;
  inputShape: typeof queryTableInput;
  handler(input: Input): Promise<McpResult>;
}

export function createQueryTableTool(client: ServiceNowClient): QueryTableTool {
  return {
    name: 'query_table',
    description:
      'Query any ServiceNow table. Returns a page of records plus optional next_offset for pagination. Default limit is 25; large limits burn context, so request only what you need.',
    inputShape: queryTableInput,
    handler: (input) =>
      runTool(async () => {
        const out = await client.table.query(input.table, {
          sysparmQuery: input.sysparm_query,
          fields: input.fields,
          limit: input.limit,
          offset: input.offset,
          displayValue: input.display_value,
        });
        const result: { records: unknown[]; total?: number; next_offset?: number } = {
          records: out.records,
        };
        if (out.total !== undefined) result.total = out.total;
        if (out.next_offset !== undefined) result.next_offset = out.next_offset;
        return result;
      }),
  };
}
