import { describe, expect, it, vi } from 'vitest';
import { createRunSavedReportTool } from './run-saved-report.js';
import type { ServiceNowClient } from '../../servicenow/client.js';
import { createResourceCache } from '../../cache/resource-cache.js';

const DISABLED = {
  dbPath: ':memory:',
  ttlLongMs: 0,
  ttlMediumMs: 0,
  ttlShortMs: 0,
  maxEntries: 10,
};
const ENABLED = {
  dbPath: ':memory:',
  ttlLongMs: 60_000,
  ttlMediumMs: 60_000,
  ttlShortMs: 60_000,
  maxEntries: 10,
};

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
    const cache = createResourceCache(DISABLED);
    const tool = createRunSavedReportTool(client, cache);
    const out = await tool.handler({ report_sys_id: 'rep1', limit: 10, offset: 0 });
    expect(runSavedReport).toHaveBeenCalledWith('rep1', { limit: 10, offset: 0 });
    const payload = JSON.parse((out.content?.[0] as { text: string }).text);
    expect(payload.definition).toEqual({ table: 'incident', columns: ['number'] });
  });
});

describe('run_saved_report tool with cache', () => {
  it('returns the cached result on second call with identical inputs without re-running the report', async () => {
    const runSavedReport = vi.fn(async () => ({ records: [], total: 0 }));
    const client = { report: { runSavedReport } } as unknown as ServiceNowClient;
    const cache = createResourceCache(ENABLED);
    const tool = createRunSavedReportTool(client, cache);

    await tool.handler({ report_sys_id: 'rep1' });
    await tool.handler({ report_sys_id: 'rep1' });

    expect(runSavedReport).toHaveBeenCalledTimes(1);
  });
});
