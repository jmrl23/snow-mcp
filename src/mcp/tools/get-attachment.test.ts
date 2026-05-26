import { describe, expect, it, vi } from 'vitest';
import { createGetAttachmentTool } from './get-attachment.js';
import type { ServiceNowClient } from '../../servicenow/client.js';

describe('get_attachment tool', () => {
  it('returns metadata plus base64 content from AttachmentApi', async () => {
    const getAttachment = vi.fn(async () => ({
      metadata: {
        name: 'a.txt',
        content_type: 'text/plain',
        size_bytes: 3,
        table: 'incident',
        record_sys_id: 'i1',
      },
      content_base64: 'AAEC',
    }));
    const client = {
      table: { query: vi.fn(), getRecord: vi.fn() },
      aggregate: { aggregate: vi.fn() },
      attachment: { getAttachment },
      report: { runSavedReport: vi.fn() },
      userContext: { getUserContext: vi.fn() },
    } as unknown as ServiceNowClient;
    const tool = createGetAttachmentTool(client);
    const out = await tool.handler({ sys_id: 'att1' });
    expect(getAttachment).toHaveBeenCalledWith('att1');
    const payload = JSON.parse((out.content?.[0] as { text: string }).text);
    expect(payload.metadata.name).toBe('a.txt');
    expect(payload.content_base64).toBe('AAEC');
  });
});
