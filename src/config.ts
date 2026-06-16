import { ConfigError } from './errors.js';

export type AuthConfig =
  | { kind: 'bearer'; token: string }
  | { kind: 'basic'; user: string; password: string }
  | { kind: 'oauth_client_credentials'; clientId: string; clientSecret: string };

export interface CacheConfig {
  ttlMs: number;
  maxEntries: number;
}

export type TransportConfig =
  | { kind: 'stdio'; host: string; port: number }
  | { kind: 'http'; host: string; port: number; authToken: string };

export interface ServerConfig {
  instanceUrl: string;
  auth: AuthConfig;
  cache: CacheConfig;
  transport: TransportConfig;
}

const REQUIRED_AUTH_HINT =
  'SNOW_OAUTH_CLIENT_ID+SNOW_OAUTH_CLIENT_SECRET, SNOW_OAUTH_TOKEN, or SNOW_USER+SNOW_PASSWORD';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const missing: string[] = [];

  const rawUrl = env.SNOW_INSTANCE_URL?.trim();
  if (!rawUrl) missing.push('SNOW_INSTANCE_URL');

  const clientId = env.SNOW_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.SNOW_OAUTH_CLIENT_SECRET?.trim();
  const token = env.SNOW_OAUTH_TOKEN?.trim();
  const user = env.SNOW_USER?.trim();
  const password = env.SNOW_PASSWORD;

  if ((clientId && !clientSecret) || (!clientId && clientSecret)) {
    throw new ConfigError('SNOW_OAUTH_CLIENT_ID and SNOW_OAUTH_CLIENT_SECRET must be set together');
  }

  let auth: AuthConfig | undefined;
  if (clientId && clientSecret) {
    auth = { kind: 'oauth_client_credentials', clientId, clientSecret };
  } else if (token) {
    auth = { kind: 'bearer', token };
  } else if (user && password) {
    auth = { kind: 'basic', user, password };
  } else {
    missing.push(`auth (${REQUIRED_AUTH_HINT})`);
  }

  if (missing.length > 0 || !rawUrl || !auth) {
    throw new ConfigError(`Missing required configuration: ${missing.join(', ')}`);
  }

  if (!rawUrl.startsWith('https://')) {
    throw new ConfigError(`SNOW_INSTANCE_URL must use https:// (got: ${rawUrl})`);
  }

  const instanceUrl = rawUrl.replace(/\/+$/, '');
  try {
    new URL(instanceUrl);
  } catch {
    throw new ConfigError(`SNOW_INSTANCE_URL is not a valid URL: ${rawUrl}`);
  }

  const cache: CacheConfig = {
    ttlMs: parseIntEnv(env, 'SCHEMA_CACHE_TTL_MS', 300_000, { min: 0 }),
    maxEntries: parseIntEnv(env, 'SCHEMA_CACHE_MAX_ENTRIES', 256, { min: 1 }),
  };

  const transportKind = (env.MCP_TRANSPORT?.trim() || 'stdio') as string;
  if (transportKind !== 'stdio' && transportKind !== 'http') {
    throw new ConfigError(`MCP_TRANSPORT must be "stdio" or "http" (got: ${transportKind})`);
  }
  const httpHost = env.MCP_HTTP_HOST?.trim() || '127.0.0.1';
  const httpPort = parseIntEnv(env, 'MCP_HTTP_PORT', 3000, { min: 1 });
  if (httpPort > 65535) {
    throw new ConfigError(`MCP_HTTP_PORT must be <= 65535 (got: ${httpPort})`);
  }
  let transport: TransportConfig;
  if (transportKind === 'http') {
    const authToken = env.MCP_AUTH_TOKEN?.trim();
    if (!authToken) {
      throw new ConfigError('MCP_AUTH_TOKEN is required when MCP_TRANSPORT=http');
    }
    transport = { kind: 'http', host: httpHost, port: httpPort, authToken };
  } else {
    transport = { kind: 'stdio', host: httpHost, port: httpPort };
  }

  return { instanceUrl, auth, cache, transport };
}

function parseIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  bounds: { min: number },
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return defaultValue;
  if (!/^-?\d+$/.test(raw)) {
    throw new ConfigError(`${name} must be an integer (got: ${raw})`);
  }
  const n = Number(raw);
  if (n < bounds.min) {
    throw new ConfigError(`${name} must be >= ${bounds.min} (got: ${raw})`);
  }
  return n;
}
