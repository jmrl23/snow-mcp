import { describe, expect, it, vi } from 'vitest';
import { createTableApi } from './table-api.js';
import type { HttpClient } from '../http/client.js';

function mockClient(response: Response): {
  client: HttpClient;
  calls: Array<{ path: string; query?: Record<string, string | undefined> }>;
} {
  const calls: Array<{ path: string; query?: Record<string, string | undefined> }> = [];
  const client: HttpClient = {
    request: vi.fn(async (path: string, opts) => {
      calls.push({ path, query: opts?.query });
      return response;
    }),
    requestRaw: vi.fn(async (_m, path, opts) => {
      calls.push({ path, query: opts?.query });
      return response;
    }),
  };
  return { client, calls };
}

function jsonResp(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('TableApi.query', () => {
  it('GETs /api/now/table/<name> with sysparm_* params', async () => {
    const { client, calls } = mockClient(jsonResp({ result: [{ sys_id: '1' }, { sys_id: '2' }] }));
    const api = createTableApi(client);
    const out = await api.query('incident', {
      sysparmQuery: 'priority=1',
      fields: ['sys_id', 'number'],
      limit: 25,
      offset: 0,
      displayValue: 'false',
    });
    expect(calls[0]?.path).toBe('/api/now/table/incident');
    expect(calls[0]?.query?.sysparm_query).toBe('priority=1');
    expect(calls[0]?.query?.sysparm_fields).toBe('sys_id,number');
    expect(calls[0]?.query?.sysparm_limit).toBe('25');
    expect(calls[0]?.query?.sysparm_offset).toBe('0');
    expect(calls[0]?.query?.sysparm_display_value).toBe('false');
    expect(out.records).toHaveLength(2);
  });

  it('includes next_offset when ServiceNow signals more results via X-Total-Count', async () => {
    const { client } = mockClient(
      jsonResp({ result: [{ sys_id: '1' }] }, 200, { 'x-total-count': '50' }),
    );
    const api = createTableApi(client);
    const out = await api.query('incident', { limit: 1, offset: 0 });
    expect(out.next_offset).toBe(1);
    expect(out.total).toBe(50);
  });

  it('omits next_offset when X-Total-Count says we have everything', async () => {
    const { client } = mockClient(
      jsonResp({ result: [{ sys_id: '1' }] }, 200, { 'x-total-count': '1' }),
    );
    const api = createTableApi(client);
    const out = await api.query('incident', { limit: 25, offset: 0 });
    expect(out.next_offset).toBeUndefined();
    expect(out.total).toBe(1);
  });

  it('getRecord GETs /api/now/table/<name>/<sys_id>', async () => {
    const { client, calls } = mockClient(jsonResp({ result: { sys_id: 'abc', number: 'INC1' } }));
    const api = createTableApi(client);
    const rec = await api.getRecord('incident', 'abc', ['sys_id', 'number']);
    expect(calls[0]?.path).toBe('/api/now/table/incident/abc');
    expect(calls[0]?.query?.sysparm_fields).toBe('sys_id,number');
    expect(rec).toEqual({ sys_id: 'abc', number: 'INC1' });
  });

  it('throws when an error response is returned (delegates to ensureOk)', async () => {
    const { client } = mockClient(jsonResp({ error: 'bad' }, 401));
    const api = createTableApi(client);
    await expect(api.query('incident', {})).rejects.toThrow(/401/);
  });
});
