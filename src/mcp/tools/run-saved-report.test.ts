import { describe, expect, it, vi } from 'vitest';
import { createRunSavedReportTool } from './run-saved-report.js';
import type { ServiceNowClient } from '../../servicenow/client.js';

describe('run_saved_report tool', () => {
  it('delegates to ReportApi.runSavedReport', async () => {
    const runSavedReport = vi.fn(async () => ({
      records: [{ number: 'INC1' }],
      total: 1,
      definition: { table: 'incident', columns: ['number'] },
    }));
    const client = {
      table: { query: vi.fn(), getRecord: vi.fn() },
      aggregate: { aggregate: vi.fn() },
      attachment: { getAttachment: vi.fn() },
      report: { runSavedReport },
      userContext: { getUserContext: vi.fn() },
    } as unknown as ServiceNowClient;
    const tool = createRunSavedReportTool(client);
    const out = await tool.handler({ report_sys_id: 'rep1', limit: 10, offset: 0 });
    expect(runSavedReport).toHaveBeenCalledWith('rep1', { limit: 10, offset: 0 });
    const payload = JSON.parse((out.content?.[0] as { text: string }).text);
    expect(payload.definition).toEqual({ table: 'incident', columns: ['number'] });
  });
});
