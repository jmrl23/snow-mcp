import { describe, expect, it } from 'vitest';
import { createAuthProvider } from './index.js';

describe('createAuthProvider', () => {
  it('builds a basic provider from { kind: "basic" }', async () => {
    const p = createAuthProvider(
      { kind: 'basic', user: 'u', password: 'p' },
      'https://example.service-now.com',
    );
    expect(await p.getAuthHeader()).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('builds a bearer-static provider from { kind: "bearer" }', async () => {
    const p = createAuthProvider(
      { kind: 'bearer', token: 'abc' },
      'https://example.service-now.com',
    );
    expect(await p.getAuthHeader()).toBe('Bearer abc');
  });

  it('builds an OAuth client_credentials provider from { kind: "oauth_client_credentials" }', () => {
    const p = createAuthProvider(
      { kind: 'oauth_client_credentials', clientId: 'id', clientSecret: 'sec' },
      'https://example.service-now.com',
    );
    expect(typeof p.getAuthHeader).toBe('function');
  });
});
