import { describe, expect, it } from 'vitest';
import type { AuthProvider } from './auth-provider.js';

describe('AuthProvider', () => {
  const buildProvider = (): AuthProvider => ({
    async getAuthHeader() {
      return 'Basic abc';
    },
    async onUnauthorized() {
      // no-op
    },
  });

  it('a concrete implementation returns the configured auth header', async () => {
    expect(await buildProvider().getAuthHeader()).toBe('Basic abc');
  });

  it('a concrete implementation resolves onUnauthorized', async () => {
    await expect(buildProvider().onUnauthorized()).resolves.toBeUndefined();
  });
});
