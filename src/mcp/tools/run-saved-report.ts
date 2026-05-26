import { z } from 'zod';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { runTool, type McpResult } from '../tool-helpers.js';

export const runSavedReportInput = {
  report_sys_id: z
    .string()
    .describe('sys_id of a row in sys_report (list-type reports only in v1).'),
  limit: z.number().int().positive().optional().describe('Max rows in this page. Default 25.'),
  offset: z.number().int().nonnegative().optional().describe('Row offset for pagination.'),
};

export interface RunSavedReportTool {
  name: 'run_saved_report';
  description: string;
  inputShape: typeof runSavedReportInput;
  handler(input: { report_sys_id: string; limit?: number; offset?: number }): Promise<McpResult>;
}

export function createRunSavedReportTool(client: ServiceNowClient): RunSavedReportTool {
  return {
    name: 'run_saved_report',
    description:
      'Execute a saved ServiceNow report (list type) by sys_id. Returns the resulting records plus the report definition.',
    inputShape: runSavedReportInput,
    handler: (input) =>
      runTool(() =>
        client.report.runSavedReport(input.report_sys_id, {
          limit: input.limit,
          offset: input.offset,
        }),
      ),
  };
}
