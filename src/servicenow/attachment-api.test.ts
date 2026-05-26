import { describe, expect, it, vi } from 'vitest';
import { createAttachmentApi } from './attachment-api.js';
import type { HttpClient } from '../http/client.js';

describe('AttachmentApi.getAttachment', () => {
  it('fetches metadata then file content', async () => {
    const calls: string[] = [];
    const client: HttpClient = {
      request: vi.fn(async (path: string) => {
        calls.push(path);
        if (path.endsWith('/file')) {
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          });
        }
        return new Response(
          JSON.stringify({
            result: {
              sys_id: 'att1',
              file_name: 'hello.txt',
              content_type: 'text/plain',
              size_bytes: '4',
              table_name: 'incident',
              table_sys_id: 'inc1',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
      requestRaw: vi.fn(),
    };
    const api = createAttachmentApi(client);
    const out = await api.getAttachment('att1');
    expect(calls).toEqual(['/api/now/attachment/att1', '/api/now/attachment/att1/file']);
    expect(out.metadata).toEqual({
      name: 'hello.txt',
      content_type: 'text/plain',
      size_bytes: 4,
      table: 'incident',
      record_sys_id: 'inc1',
    });
    expect(Buffer.from(out.content_base64, 'base64')).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('throws when metadata returns 404', async () => {
    const client: HttpClient = {
      request: vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'gone' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
      ),
      requestRaw: vi.fn(),
    };
    const api = createAttachmentApi(client);
    await expect(api.getAttachment('nope')).rejects.toThrow(/404/);
  });
});
