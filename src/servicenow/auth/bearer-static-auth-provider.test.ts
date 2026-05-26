import { describe, expect, it } from 'vitest';
import { createBearerStaticAuthProvider } from './bearer-static-auth-provider.js';

describe('createBearerStaticAuthProvider', () => {
  it('returns Bearer <token>', async () => {
    const provider = createBearerStaticAuthProvider({ token: 'abc' });
    expect(await provider.getAuthHeader()).toBe('Bearer abc');
  });

  it('onUnauthorized resolves without throwing', async () => {
    const provider = createBearerStaticAuthProvider({ token: 'abc' });
    await expect(provider.onUnauthorized()).resolves.toBeUndefined();
  });
});
