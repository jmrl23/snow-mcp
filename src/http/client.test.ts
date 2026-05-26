import { describe, expect, it } from 'vitest';
import { createHttpClient } from './client.js';
import { ReadOnlyViolationError } from '../errors.js';
import type { ServerConfig } from '../config.js';

const cfgBasic: ServerConfig = {
  instanceUrl: 'https://example.service-now.com',
  auth: { kind: 'basic', user: 'u', password: 'p' },
  cache: { ttlMs: 0, maxEntries: 0 },
};
const cfgBearer: ServerConfig = {
  instanceUrl: 'https://example.service-now.com',
  auth: { kind: 'bearer', token: 'abc' },
  cache: { ttlMs: 0, maxEntries: 0 },
};

function fakeFetch(): {
  fn: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

describe('createHttpClient', () => {
  it('request() issues GET with full URL composed from instance + path', async () => {
    const { fn, calls } = fakeFetch();
    const client = createHttpClient(cfgBasic, fn);
    await client.request('/api/now/table/incident');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://example.service-now.com/api/now/table/incident');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('appends query parameters, skipping undefined', async () => {
    const { fn, calls } = fakeFetch();
    const client = createHttpClient(cfgBasic, fn);
    await client.request('/api/now/table/incident', {
      query: { sysparm_limit: '25', sysparm_query: undefined, sysparm_offset: '0' },
    });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('sysparm_limit')).toBe('25');
    expect(url.searchParams.get('sysparm_offset')).toBe('0');
    expect(url.searchParams.has('sysparm_query')).toBe(false);
  });

  it('injects Basic auth header', async () => {
    const { fn, calls } = fakeFetch();
    const client = createHttpClient(cfgBasic, fn);
    await client.request('/x');
    const headers = new Headers(calls[0]!.init!.headers);
    expect(headers.get('authorization')).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect(headers.get('accept')).toBe('application/json');
  });

  it('injects Bearer auth header', async () => {
    const { fn, calls } = fakeFetch();
    const client = createHttpClient(cfgBearer, fn);
    await client.request('/x');
    const headers = new Headers(calls[0]!.init!.headers);
    expect(headers.get('authorization')).toBe('Bearer abc');
  });

  it('requestRaw throws ReadOnlyViolationError for POST', async () => {
    const { fn } = fakeFetch();
    const client = createHttpClient(cfgBasic, fn);
    await expect(client.requestRaw('POST' as 'GET', '/x')).rejects.toBeInstanceOf(
      ReadOnlyViolationError,
    );
  });

  it('requestRaw throws for PUT, PATCH, DELETE', async () => {
    const { fn } = fakeFetch();
    const client = createHttpClient(cfgBasic, fn);
    for (const m of ['PUT', 'PATCH', 'DELETE'] as const) {
      await expect(client.requestRaw(m as 'GET', '/x')).rejects.toBeInstanceOf(
        ReadOnlyViolationError,
      );
    }
  });

  it('redact() strips Authorization header values and known secret-named keys', async () => {
    const { redact } = await import('./client.js');
    const out = redact({
      headers: { Authorization: 'Bearer secret', 'X-Other': 'ok' },
      env: { SNOW_PASSWORD: 'pw', SNOW_OAUTH_TOKEN: 'tok', SNOW_INSTANCE_URL: 'url' },
      nested: { authorization: 'Basic xxx', other: 'visible' },
    }) as Record<string, unknown>;
    const s = JSON.stringify(out);
    expect(s).not.toContain('secret');
    expect(s).not.toContain('pw');
    expect(s).not.toContain('tok');
    expect(s).not.toContain('Basic xxx');
    expect(s).toContain('visible');
    expect(s).toContain('url');
  });
});

function fakeFetchSequence(responses: Response[]): {
  fn: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let idx = 0;
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const res = responses[Math.min(idx, responses.length - 1)];
    idx += 1;
    return res as Response;
  }) as typeof fetch;
  return { fn, calls };
}

describe('createHttpClient — 401 retry', () => {
  it('retries the request exactly once after a 401 and surfaces the second response', async () => {
    const { fn, calls } = fakeFetchSequence([
      new Response('{}', { status: 401 }),
      new Response('{"result":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const client = createHttpClient(cfgBasic, fn);
    const res = await client.request('/api/now/table/incident');
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('does not retry more than once on persistent 401', async () => {
    const { fn, calls } = fakeFetchSequence([
      new Response('{}', { status: 401 }),
      new Response('{}', { status: 401 }),
      new Response('{}', { status: 401 }),
    ]);
    const client = createHttpClient(cfgBasic, fn);
    const res = await client.request('/api/now/table/incident');
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(2);
  });
});
