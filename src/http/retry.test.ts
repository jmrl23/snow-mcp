import { describe, expect, it, vi } from 'vitest';
import { withRetry, parseRetryAfter } from './retry.js';

function _makeFetch(responses: Array<() => Promise<Response>>): typeof fetch {
  let i = 0;
  return (async () => {
    const next = responses[i] ?? responses[responses.length - 1]!;
    i++;
    return next();
  }) as typeof fetch;
}

describe('withRetry', () => {
  it('returns successful response without retry', async () => {
    const fn = vi.fn(async () => new Response('ok', { status: 200 }));
    const res = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitterPct: 0 });
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx and eventually succeeds', async () => {
    const fn = vi.fn();
    fn.mockResolvedValueOnce(new Response('err', { status: 500 }));
    fn.mockResolvedValueOnce(new Response('err', { status: 503 }));
    fn.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitterPct: 0 });
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries on 429 and eventually succeeds', async () => {
    const fn = vi.fn();
    fn.mockResolvedValueOnce(new Response('rl', { status: 429 }));
    fn.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitterPct: 0 });
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('returns the last 5xx response after maxAttempts', async () => {
    const fn = vi.fn(async () => new Response('err', { status: 502 }));
    const res = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitterPct: 0 });
    expect(res.status).toBe(502);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry 4xx (except 429)', async () => {
    const fn = vi.fn(async () => new Response('bad', { status: 400 }));
    const res = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitterPct: 0 });
    expect(res.status).toBe(400);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries network errors like 5xx', async () => {
    const fn = vi.fn();
    fn.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'ECONNRESET' }));
    fn.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitterPct: 0 });
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('parseRetryAfter handles delta-seconds and HTTP-date', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('   12   ')).toBe(12000);
    expect(parseRetryAfter('not a number')).toBeUndefined();
    const future = new Date(Date.now() + 3000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(5000);
  });
});
