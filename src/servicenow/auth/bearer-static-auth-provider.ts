import type { AuthProvider } from './auth-provider.js';

export interface BearerStaticOptions {
  token: string;
}

export function createBearerStaticAuthProvider(opts: BearerStaticOptions): AuthProvider {
  const header = `Bearer ${opts.token}`;
  return {
    async getAuthHeader() {
      return header;
    },
    async onUnauthorized() {
      // static token has no refresh
    },
  };
}
