import { ConfigError } from './errors.js';

export type AuthConfig =
  | { kind: 'bearer'; token: string }
  | { kind: 'basic'; user: string; password: string };

export interface CacheConfig {
  ttlMs: number;
  maxEntries: number;
}

export interface ServerConfig {
  instanceUrl: string;
  auth: AuthConfig;
  cache: CacheConfig;
}

const REQUIRED_AUTH_HINT = 'either SNOW_OAUTH_TOKEN, or both SNOW_USER and SNOW_PASSWORD';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const missing: string[] = [];

  const rawUrl = env.SNOW_INSTANCE_URL?.trim();
  if (!rawUrl) missing.push('SNOW_INSTANCE_URL');

  const token = env.SNOW_OAUTH_TOKEN?.trim();
  const user = env.SNOW_USER?.trim();
  const password = env.SNOW_PASSWORD;
  let auth: AuthConfig | undefined;
  if (token) {
    auth = { kind: 'bearer', token };
  } else if (user && password) {
    auth = { kind: 'basic', user, password };
  } else {
    missing.push(`SNOW_OAUTH_TOKEN`, `SNOW_USER`, `SNOW_PASSWORD (${REQUIRED_AUTH_HINT})`);
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

  return { instanceUrl, auth, cache };
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
