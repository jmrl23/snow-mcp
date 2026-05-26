import { describe, expect, it } from 'vitest';
import { createBasicAuthProvider } from './basic-auth-provider.js';

describe('createBasicAuthProvider', () => {
  it('returns the Basic <base64(user:password)> header', async () => {
    const provider = createBasicAuthProvider({ user: 'u', password: 'p' });
    expect(await provider.getAuthHeader()).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('onUnauthorized resolves without throwing', async () => {
    const provider = createBasicAuthProvider({ user: 'u', password: 'p' });
    await expect(provider.onUnauthorized()).resolves.toBeUndefined();
  });
});
