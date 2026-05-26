import { ConfigError } from './errors.js';

export type AuthConfig =
  | { kind: 'bearer'; token: string }
  | { kind: 'basic'; user: string; password: string };

export interface ServerConfig {
  instanceUrl: string;
  auth: AuthConfig;
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

  return { instanceUrl, auth };
}
