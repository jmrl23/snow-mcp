import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createOAuthClientCredentialsProvider } from './oauth-client-credentials-provider.js';

const BASE_OPTS = {
  instanceUrl: 'https://example.service-now.com',
  clientId: 'id',
  clientSecret: 'secret',
};

function fetchReturning(responses: Response[]): {
  fn: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let idx = 0;
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const res = responses[idx];
    idx = Math.min(idx + 1, responses.length - 1);
    return res as Response;
  }) as typeof fetch;
  return { fn, calls };
}

function tokenResponse(token: string, expiresIn: number): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createOAuthClientCredentialsProvider', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') }));
  afterEach(() => vi.useRealTimers());

  it('fetches a token on first call and returns Bearer <token>', async () => {
    const { fn, calls } = fetchReturning([tokenResponse('tok1', 3600)]);
    const provider = createOAuthClientCredentialsProvider(BASE_OPTS, fn);
    expect(await provider.getAuthHeader()).toBe('Bearer tok1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://example.service-now.com/oauth_token.do');
    expect(calls[0]?.init?.method).toBe('POST');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const body = String(calls[0]?.init?.body ?? '');
    expect(body).toContain('grant_type=client_credentials');
    expect(body).toContain('client_id=id');
    expect(body).toContain('client_secret=secret');
  });

  it('reuses the cached token on subsequent calls within ttl', async () => {
    const { fn, calls } = fetchReturning([tokenResponse('tok1', 3600)]);
    const provider = createOAuthClientCredentialsProvider(BASE_OPTS, fn);
    await provider.getAuthHeader();
    await provider.getAuthHeader();
    expect(calls).toHaveLength(1);
  });

  it('refreshes the token after expiry (expires_in - 30s)', async () => {
    const { fn, calls } = fetchReturning([tokenResponse('tok1', 60), tokenResponse('tok2', 60)]);
    const provider = createOAuthClientCredentialsProvider(BASE_OPTS, fn);
    expect(await provider.getAuthHeader()).toBe('Bearer tok1');
    vi.advanceTimersByTime(31_000); // past (60-30)*1000
    expect(await provider.getAuthHeader()).toBe('Bearer tok2');
    expect(calls).toHaveLength(2);
  });

  it('onUnauthorized invalidates the cached token, forcing a refresh', async () => {
    const { fn, calls } = fetchReturning([
      tokenResponse('tok1', 3600),
      tokenResponse('tok2', 3600),
    ]);
    const provider = createOAuthClientCredentialsProvider(BASE_OPTS, fn);
    expect(await provider.getAuthHeader()).toBe('Bearer tok1');
    await provider.onUnauthorized();
    expect(await provider.getAuthHeader()).toBe('Bearer tok2');
    expect(calls).toHaveLength(2);
  });

  it('throws ServiceNowAuthError when the token endpoint returns 401', async () => {
    const { fn } = fetchReturning([
      new Response(JSON.stringify({ error: 'invalid_client' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const provider = createOAuthClientCredentialsProvider(BASE_OPTS, fn);
    await expect(provider.getAuthHeader()).rejects.toMatchObject({
      name: 'ServiceNowAuthError',
    });
  });

  it('throws ServiceNowAuthError when the token endpoint returns 403', async () => {
    const { fn } = fetchReturning([
      new Response(JSON.stringify({ error: 'access_denied' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const provider = createOAuthClientCredentialsProvider(BASE_OPTS, fn);
    await expect(provider.getAuthHeader()).rejects.toMatchObject({
      name: 'ServiceNowAuthError',
    });
  });

  it('throws ServiceNowServerError when the token endpoint returns 5xx', async () => {
    const { fn } = fetchReturning([
      new Response(JSON.stringify({ error: 'server_error' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const provider = createOAuthClientCredentialsProvider(BASE_OPTS, fn);
    await expect(provider.getAuthHeader()).rejects.toMatchObject({
      name: 'ServiceNowServerError',
    });
  });
});
