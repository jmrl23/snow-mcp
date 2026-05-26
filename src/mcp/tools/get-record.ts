import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const getRecordInput = {
  table: z.string().describe('ServiceNow table name.'),
  sys_id: z.string().describe('The record sys_id.'),
  fields: z
    .array(z.string())
    .optional()
    .describe('Field allowlist. Omit to return all readable fields.'),
};

export interface GetRecordTool {
  name: 'get_record';
  description: string;
  inputShape: typeof getRecordInput;
  handler(input: { table: string; sys_id: string; fields?: string[] }): Promise<McpResult>;
}

export function createGetRecordTool(client: ServiceNowClient): GetRecordTool {
  return {
    name: 'get_record',
    description: 'Fetch a single ServiceNow record by table and sys_id.',
    inputShape: getRecordInput,
    handler: (input) =>
      runTool(() => client.table.getRecord(input.table, input.sys_id, input.fields)),
  };
}
