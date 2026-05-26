import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { ConfigError } from './errors.js';

const BASE = { SNOW_INSTANCE_URL: 'https://example.service-now.com' };

describe('loadConfig', () => {
  it('throws ConfigError naming every missing variable when env is empty', () => {
    const err = (() => {
      try {
        loadConfig({});
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain('SNOW_INSTANCE_URL');
    expect((err as Error).message).toContain('SNOW_OAUTH_CLIENT_ID');
    expect((err as Error).message).toContain('SNOW_OAUTH_CLIENT_SECRET');
    expect((err as Error).message).toContain('SNOW_OAUTH_TOKEN');
    expect((err as Error).message).toContain('SNOW_USER');
    expect((err as Error).message).toContain('SNOW_PASSWORD');
  });

  it('rejects non-https URLs', () => {
    expect(() =>
      loadConfig({ SNOW_INSTANCE_URL: 'http://example.service-now.com', SNOW_OAUTH_TOKEN: 't' }),
    ).toThrow(/https/);
  });

  it('strips trailing slash from instance URL', () => {
    const cfg = loadConfig({
      SNOW_INSTANCE_URL: 'https://example.service-now.com/',
      SNOW_OAUTH_TOKEN: 't',
    });
    expect(cfg.instanceUrl).toBe('https://example.service-now.com');
  });

  it('selects bearer auth when SNOW_OAUTH_TOKEN is set', () => {
    const cfg = loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 'abc' });
    expect(cfg.auth).toEqual({ kind: 'bearer', token: 'abc' });
  });

  it('selects bearer over basic when both are present', () => {
    const cfg = loadConfig({
      ...BASE,
      SNOW_OAUTH_TOKEN: 'abc',
      SNOW_USER: 'u',
      SNOW_PASSWORD: 'p',
    });
    expect(cfg.auth).toEqual({ kind: 'bearer', token: 'abc' });
  });

  it('selects basic auth when only SNOW_USER + SNOW_PASSWORD are set', () => {
    const cfg = loadConfig({ ...BASE, SNOW_USER: 'u', SNOW_PASSWORD: 'p' });
    expect(cfg.auth).toEqual({ kind: 'basic', user: 'u', password: 'p' });
  });

  it('rejects when only SNOW_USER is set without SNOW_PASSWORD', () => {
    expect(() => loadConfig({ ...BASE, SNOW_USER: 'u' })).toThrow(ConfigError);
  });

  it('defaults SCHEMA_CACHE_TTL_MS to 300000', () => {
    const cfg = loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't' });
    expect(cfg.cache.ttlMs).toBe(300_000);
  });

  it('defaults SCHEMA_CACHE_MAX_ENTRIES to 256', () => {
    const cfg = loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't' });
    expect(cfg.cache.maxEntries).toBe(256);
  });

  it('parses SCHEMA_CACHE_TTL_MS=0 as disabled', () => {
    const cfg = loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't', SCHEMA_CACHE_TTL_MS: '0' });
    expect(cfg.cache.ttlMs).toBe(0);
  });

  it('rejects non-integer SCHEMA_CACHE_TTL_MS', () => {
    expect(() =>
      loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't', SCHEMA_CACHE_TTL_MS: 'abc' }),
    ).toThrow(/SCHEMA_CACHE_TTL_MS/);
  });

  it('rejects negative SCHEMA_CACHE_TTL_MS', () => {
    expect(() => loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't', SCHEMA_CACHE_TTL_MS: '-1' })).toThrow(
      /SCHEMA_CACHE_TTL_MS/,
    );
  });

  it('rejects SCHEMA_CACHE_MAX_ENTRIES below 1', () => {
    expect(() =>
      loadConfig({ ...BASE, SNOW_OAUTH_TOKEN: 't', SCHEMA_CACHE_MAX_ENTRIES: '0' }),
    ).toThrow(/SCHEMA_CACHE_MAX_ENTRIES/);
  });

  it('selects oauth_client_credentials when SNOW_OAUTH_CLIENT_ID and SNOW_OAUTH_CLIENT_SECRET are set', () => {
    const cfg = loadConfig({
      ...BASE,
      SNOW_OAUTH_CLIENT_ID: 'id',
      SNOW_OAUTH_CLIENT_SECRET: 'sec',
    });
    expect(cfg.auth).toEqual({
      kind: 'oauth_client_credentials',
      clientId: 'id',
      clientSecret: 'sec',
    });
  });

  it('prefers oauth_client_credentials over bearer token when both are set', () => {
    const cfg = loadConfig({
      ...BASE,
      SNOW_OAUTH_CLIENT_ID: 'id',
      SNOW_OAUTH_CLIENT_SECRET: 'sec',
      SNOW_OAUTH_TOKEN: 'abc',
      SNOW_USER: 'u',
      SNOW_PASSWORD: 'p',
    });
    expect(cfg.auth.kind).toBe('oauth_client_credentials');
  });

  it('rejects partial OAuth client_credentials (only CLIENT_ID)', () => {
    expect(() => loadConfig({ ...BASE, SNOW_OAUTH_CLIENT_ID: 'id' })).toThrow(
      /SNOW_OAUTH_CLIENT_SECRET/,
    );
  });

  it('rejects partial OAuth client_credentials (only CLIENT_SECRET)', () => {
    expect(() => loadConfig({ ...BASE, SNOW_OAUTH_CLIENT_SECRET: 'sec' })).toThrow(
      /SNOW_OAUTH_CLIENT_ID/,
    );
  });
});
