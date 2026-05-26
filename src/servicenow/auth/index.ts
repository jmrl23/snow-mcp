import type { AuthConfig } from '../../config.js';
import type { AuthProvider } from './auth-provider.js';
import { createBasicAuthProvider } from './basic-auth-provider.js';
import { createBearerStaticAuthProvider } from './bearer-static-auth-provider.js';
import { createOAuthClientCredentialsProvider } from './oauth-client-credentials-provider.js';

export type { AuthProvider } from './auth-provider.js';

export function createAuthProvider(
  auth: AuthConfig,
  instanceUrl: string,
  fetchImpl: typeof fetch = fetch,
): AuthProvider {
  switch (auth.kind) {
    case 'basic':
      return createBasicAuthProvider({ user: auth.user, password: auth.password });
    case 'bearer':
      return createBearerStaticAuthProvider({ token: auth.token });
    case 'oauth_client_credentials':
      return createOAuthClientCredentialsProvider(
        { instanceUrl, clientId: auth.clientId, clientSecret: auth.clientSecret },
        fetchImpl,
      );
  }
}
