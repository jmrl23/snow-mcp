import { ReadOnlyViolationError } from '../errors.js';
import type { AuthConfig, ServerConfig } from '../config.js';

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
): HttpClient {
  const authHeader = buildAuthHeader(config.auth);

  async function requestRaw(
    method: 'GET',
    path: string,
    opts: RequestOptions = {},
  ): Promise<Response> {
    // Cast forces TS to keep the runtime check even though `method` is typed `'GET'`.
    // Callers may bypass the type via `as`, and this guard catches them.
    if ((method as string) !== ALLOWED_METHOD) {
      throw new ReadOnlyViolationError(method);
    }
    const url = new URL(path.replace(/^\/+/, '/'), config.instanceUrl + '/');
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }
    const headers = new Headers(opts.headers);
    headers.set('Authorization', authHeader);
    headers.set('Accept', 'application/json');
    return fetchImpl(url.toString(), { method, headers, signal: opts.signal });
  }

  return {
    request: (path, opts) => requestRaw('GET', path, opts),
    requestRaw,
  };
}

function buildAuthHeader(auth: AuthConfig): string {
  if (auth.kind === 'bearer') return `Bearer ${auth.token}`;
  if (auth.kind === 'basic')
    return `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString('base64')}`;
  // NOTE: oauth_client_credentials requires a live token fetch; callers must
  // migrate to AuthProvider before relying on this code path (Task 16).
  throw new Error('oauth_client_credentials auth must be handled via AuthProvider');
}

const REDACTED = '[REDACTED]';
const SECRET_KEY_PATTERNS = [
  /^authorization$/i,
  /^snow_password$/i,
  /^snow_oauth_token$/i,
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
