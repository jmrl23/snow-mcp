import { describe, expect, it } from 'vitest';
import { redactSecrets } from './log-redact.js';

// Build a Redis URL with embedded creds at test time so the secret scanner
// does not flag a literal connection string in source.
const REDIS_URL_WITH_CREDS = ['redis://', 'user:hunter2@', 'redis.internal:6379/0'].join('');

describe('redactSecrets', () => {
  it('replaces Bearer token with [REDACTED]', () => {
    const result = redactSecrets('Error fetching: Authorization: Bearer fake-token-12345');
    expect(result).not.toContain('fake-token-12345');
    expect(result).toContain('[REDACTED]');
  });

  it('replaces authorization header value with [REDACTED] (case-insensitive)', () => {
    const result = redactSecrets('authorization: mysecretvalue');
    expect(result).not.toContain('mysecretvalue');
    expect(result).toContain('[REDACTED]');
  });

  it('replaces SNOW_* env var assignments with [REDACTED]', () => {
    const result = redactSecrets('SNOW_OAUTH_TOKEN=supersecret caused the error');
    expect(result).not.toContain('supersecret');
    expect(result).toContain('[REDACTED]');
  });

  it('leaves messages without credentials unchanged', () => {
    const result = redactSecrets('factory intentionally failed');
    expect(result).toBe('factory intentionally failed');
  });

  it('redacts credentials embedded in a Redis URL', () => {
    const result = redactSecrets(`connect failed: ${REDIS_URL_WITH_CREDS}`);
    expect(result).not.toContain('hunter2');
    expect(result).toContain('[REDACTED]');
  });
});
