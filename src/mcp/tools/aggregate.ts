import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const aggregateInput = {
  table: z.string().describe('ServiceNow table name.'),
  operation: z.enum(['count', 'avg', 'sum', 'min', 'max']).describe('Aggregate operation.'),
  field: z.string().optional().describe('Required for avg/sum/min/max. Ignored for count.'),
  group_by: z
    .array(z.string())
    .optional()
    .describe('Group rows by these fields before aggregating.'),
  sysparm_query: z
    .string()
    .optional()
    .describe('Optional ServiceNow encoded query to filter rows.'),
};

type Input = {
  table: string;
  operation: 'count' | 'avg' | 'sum' | 'min' | 'max';
  field?: string;
  group_by?: string[];
  sysparm_query?: string;
};

export interface AggregateTool {
  name: 'aggregate';
  description: string;
  inputShape: typeof aggregateInput;
  handler(input: Input): Promise<McpResult>;
}

export function createAggregateTool(client: ServiceNowClient): AggregateTool {
  return {
    name: 'aggregate',
    description:
      'Run a ServiceNow aggregate query (count/avg/sum/min/max) optionally grouped by fields.',
    inputShape: aggregateInput,
    handler: (input) =>
      runTool(() =>
        client.aggregate.aggregate(input.table, {
          operation: input.operation,
          field: input.field,
          groupBy: input.group_by,
          sysparmQuery: input.sysparm_query,
        }),
      ),
  };
}
