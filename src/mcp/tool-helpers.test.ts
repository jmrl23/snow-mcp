import { describe, expect, it } from 'vitest';
import { toMcpResult, runTool } from './tool-helpers.js';
import { ServiceNowAuthError, ServiceNowNotFoundError } from '../errors.js';

describe('toMcpResult', () => {
  it('wraps a successful value as a JSON content block', () => {
    const r = toMcpResult({ ok: true, n: 1 });
    expect(r).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1 }, null, 2) }],
    });
  });
});

describe('runTool', () => {
  it('returns the handler result wrapped via toMcpResult on success', async () => {
    const out = await runTool(async () => ({ hello: 'world' }));
    expect(out.isError).toBeUndefined();
    expect(out.content?.[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('hello'),
    });
  });

  it('maps ServiceNowNotFoundError to a not_found error block', async () => {
    const out = await runTool(async () => {
      throw new ServiceNowNotFoundError(404, { error: 'gone' }, 'gone');
    });
    expect(out.isError).toBe(true);
    const text = (out.content?.[0] as { text: string }).text;
    expect(text).toContain('not_found');
    expect(text).not.toContain('Bearer');
  });

  it('maps ServiceNowAuthError to an auth_error block', async () => {
    const out = await runTool(async () => {
      throw new ServiceNowAuthError(401, null, 'denied');
    });
    expect(out.isError).toBe(true);
    expect((out.content?.[0] as { text: string }).text).toContain('auth_error');
  });

  it('maps unknown errors to internal_error block without leaking stack', async () => {
    const out = await runTool(async () => {
      throw new Error('boom');
    });
    expect(out.isError).toBe(true);
    const text = (out.content?.[0] as { text: string }).text;
    expect(text).toContain('internal_error');
    expect(text).not.toContain('at ');
  });
});
