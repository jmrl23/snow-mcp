import { describe, expect, it } from 'vitest';
import { ensureOk } from './translate-error.js';
import {
  ServiceNowAuthError,
  ServiceNowClientError,
  ServiceNowNotFoundError,
  ServiceNowRateLimitError,
  ServiceNowServerError,
} from '../errors.js';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('ensureOk', () => {
  it('returns response unchanged on 200', async () => {
    const r = jsonResponse(200, { ok: true });
    await expect(ensureOk(r)).resolves.toBe(r);
  });

  it('throws ServiceNowAuthError on 401 and 403', async () => {
    await expect(ensureOk(jsonResponse(401, { error: 'no' }))).rejects.toBeInstanceOf(
      ServiceNowAuthError,
    );
    await expect(ensureOk(jsonResponse(403, { error: 'no' }))).rejects.toBeInstanceOf(
      ServiceNowAuthError,
    );
  });

  it('throws ServiceNowNotFoundError on 404', async () => {
    await expect(ensureOk(jsonResponse(404, { error: 'gone' }))).rejects.toBeInstanceOf(
      ServiceNowNotFoundError,
    );
  });

  it('throws ServiceNowClientError on other 4xx', async () => {
    await expect(ensureOk(jsonResponse(400, { error: 'bad' }))).rejects.toBeInstanceOf(
      ServiceNowClientError,
    );
    await expect(ensureOk(jsonResponse(409, { error: 'conflict' }))).rejects.toBeInstanceOf(
      ServiceNowClientError,
    );
  });

  it('throws ServiceNowRateLimitError on 429 with retry-after', async () => {
    const r = jsonResponse(429, { error: 'rl' }, { 'retry-after': '7' });
    try {
      await ensureOk(r);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceNowRateLimitError);
      expect((e as ServiceNowRateLimitError).retryAfterMs).toBe(7000);
    }
  });

  it('throws ServiceNowServerError on 5xx', async () => {
    await expect(ensureOk(jsonResponse(500, { error: 'oops' }))).rejects.toBeInstanceOf(
      ServiceNowServerError,
    );
    await expect(ensureOk(jsonResponse(503, { error: 'busy' }))).rejects.toBeInstanceOf(
      ServiceNowServerError,
    );
  });

  it('handles non-JSON bodies without crashing', async () => {
    const r = new Response('plain text', { status: 500 });
    await expect(ensureOk(r)).rejects.toBeInstanceOf(ServiceNowServerError);
  });
});
