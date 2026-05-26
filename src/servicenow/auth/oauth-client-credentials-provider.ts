import type { AuthProvider } from './auth-provider.js';
import { ServiceNowAuthError, ServiceNowServerError } from '../../errors.js';

export interface OAuthClientCredentialsOptions {
  instanceUrl: string;
  clientId: string;
  clientSecret: string;
}

interface TokenState {
  token: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

const REFRESH_LEEWAY_MS = 30_000;

export function createOAuthClientCredentialsProvider(
  opts: OAuthClientCredentialsOptions,
  fetchImpl: typeof fetch = fetch,
): AuthProvider {
  let state: TokenState | undefined;

  async function fetchToken(): Promise<TokenState> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    });
    const res = await fetchImpl(`${opts.instanceUrl}/oauth_token.do`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (res.status === 401 || res.status === 403) {
      throw new ServiceNowAuthError(
        res.status,
        await safeJson(res),
        'OAuth token request rejected (check SNOW_OAUTH_CLIENT_ID / SNOW_OAUTH_CLIENT_SECRET)',
      );
    }
    if (!res.ok) {
      throw new ServiceNowServerError(
        res.status,
        await safeJson(res),
        `OAuth token request failed with status ${res.status}`,
      );
    }
    const data = (await res.json()) as TokenResponse;
    if (!data.access_token || typeof data.expires_in !== 'number') {
      throw new ServiceNowServerError(
        res.status,
        data,
        'OAuth token response missing access_token or expires_in',
      );
    }
    return {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(0, data.expires_in * 1000 - REFRESH_LEEWAY_MS),
    };
  }

  return {
    async getAuthHeader() {
      if (!state || Date.now() >= state.expiresAt) {
        state = await fetchToken();
      }
      return `Bearer ${state.token}`;
    },
    async onUnauthorized() {
      state = undefined;
    },
  };
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
