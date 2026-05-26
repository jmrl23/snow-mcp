import type { AuthProvider } from './auth-provider.js';

export interface BasicAuthOptions {
  user: string;
  password: string;
}

export function createBasicAuthProvider(opts: BasicAuthOptions): AuthProvider {
  const header = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString('base64')}`;
  return {
    async getAuthHeader() {
      return header;
    },
    async onUnauthorized() {
      // basic auth doesn't refresh
    },
  };
}
