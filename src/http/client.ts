import { ReadOnlyViolationError } from '../errors.js';
import type { ServerConfig } from '../config.js';
import { createAuthProvider, type AuthProvider } from '../servicenow/auth/index.js';

export interface RequestOptions {
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface HttpClient {
  request(path: string, opts?: RequestOptions): Promise<Response>;
  requestRaw(method: 'GET', path: string, opts?: RequestOptions): Promise<Response>;
}

const ALLOWED_METHOD = 'GET';

export function createHttpClient(
  config: ServerConfig,
  fetchImpl: typeof fetch = fetch,
  authProvider: AuthProvider = createAuthProvider(config.auth, config.instanceUrl, fetchImpl),
): HttpClient {
  async function requestRaw(
    method: 'GET',
    path: string,
    opts: RequestOptions = {},
  ): Promise<Response> {
    if ((method as string) !== ALLOWED_METHOD) {
      throw new ReadOnlyViolationError(method);
    }
    const url = new URL(path.replace(/^\/+/, '/'), config.instanceUrl + '/');
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }

    const send = async () => {
      const headers = new Headers(opts.headers);
      headers.set('Authorization', await authProvider.getAuthHeader());
      headers.set('Accept', 'application/json');
      return fetchImpl(url.toString(), { method, headers, signal: opts.signal });
    };

    const first = await send();
    if (first.status !== 401) return first;
    await authProvider.onUnauthorized();
    return send();
  }

  return {
    request: (path, opts) => requestRaw('GET', path, opts),
    requestRaw,
  };
}

const REDACTED = '[REDACTED]';
const SECRET_KEY_PATTERNS = [
  /^authorization$/i,
  /^snow_password$/i,
  /^snow_oauth_token$/i,
  /^snow_oauth_client_secret$/i,
  /password/i,
  /token/i,
  /secret/i,
];

export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERNS.some((p) => p.test(k))) {
      out[k] = REDACTED;
    } else {
      out[k] = redact(v, seen);
    }
  }
  return out;
}
