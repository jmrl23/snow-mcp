import { describe, expect, it } from 'vitest';
import { createServiceNowClient } from './client.js';
import type { ServerConfig } from '../config.js';

const cfg: ServerConfig = {
  instanceUrl: 'https://example.service-now.com',
  auth: { kind: 'bearer', token: 't' },
  cache: { ttlMs: 0, maxEntries: 0 },
  transport: { kind: 'stdio', host: '127.0.0.1', port: 3000 },
};

describe('createServiceNowClient', () => {
  it('exposes table, aggregate, attachment, report, and userContext APIs', () => {
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    const client = createServiceNowClient(cfg, fetchImpl);
    expect(typeof client.table.query).toBe('function');
    expect(typeof client.table.getRecord).toBe('function');
    expect(typeof client.aggregate.aggregate).toBe('function');
    expect(typeof client.attachment.getAttachment).toBe('function');
    expect(typeof client.report.runSavedReport).toBe('function');
    expect(typeof client.userContext.getUserContext).toBe('function');
  });
});
