import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  ReadOnlyViolationError,
  ServiceNowAuthError,
  ServiceNowClientError,
  ServiceNowNotFoundError,
  ServiceNowRateLimitError,
  ServiceNowServerError,
} from './errors.js';

describe('error classes', () => {
  it('ConfigError has correct name and message', () => {
    const e = new ConfigError('missing FOO');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ConfigError');
    expect(e.message).toBe('missing FOO');
  });

  it('ReadOnlyViolationError mentions the method', () => {
    const e = new ReadOnlyViolationError('POST');
    expect(e.name).toBe('ReadOnlyViolationError');
    expect(e.message).toContain('POST');
  });

  it('ServiceNowAuthError carries status and body', () => {
    const e = new ServiceNowAuthError(401, { error: 'invalid' }, 'auth failed');
    expect(e.status).toBe(401);
    expect(e.body).toEqual({ error: 'invalid' });
    expect(e.name).toBe('ServiceNowAuthError');
  });

  it('ServiceNowNotFoundError, ClientError, ServerError have correct names', () => {
    expect(new ServiceNowNotFoundError(404, null, 'gone').name).toBe('ServiceNowNotFoundError');
    expect(new ServiceNowClientError(400, null, 'bad').name).toBe('ServiceNowClientError');
    expect(new ServiceNowServerError(500, null, 'oops').name).toBe('ServiceNowServerError');
  });

  it('ServiceNowRateLimitError records retry-after', () => {
    const e = new ServiceNowRateLimitError(429, null, 'slow down', 5000);
    expect(e.retryAfterMs).toBe(5000);
    expect(e.name).toBe('ServiceNowRateLimitError');
  });
});
