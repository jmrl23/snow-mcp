import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { RedisClientType } from 'redis';
import { createRedisSchemaCache } from './schema-cache-redis.js';
import { DESCRIBE_CACHE_NAMESPACE } from '../mcp/server.js';

type FakeRedis = {
  store: Map<string, { value: string; exSeconds?: number }>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  scan: ReturnType<typeof vi.fn>;
};

function makeFakeRedis(): FakeRedis {
  const store = new Map<string, { value: string; exSeconds?: number }>();

  const get = vi.fn(async (key: string) => {
    const entry = store.get(key);
    return entry ? entry.value : null;
  });

  const set = vi.fn(async (key: string, value: string, opts?: { EX?: number }) => {
    store.set(key, { value, exSeconds: opts?.EX });
    return 'OK';
  });

  const del = vi.fn(async (keys: string[]) => {
    for (const k of keys) store.delete(k);
    return keys.length;
  });

  const scan = vi.fn(async (_cursor: string, _opts?: { MATCH?: string; COUNT?: number }) => {
    return { cursor: '0', keys: [] as string[] };
  });

  return { store, get, set, del, scan };
}

function asRedis(fake: FakeRedis): RedisClientType {
  return fake as unknown as RedisClientType;
}

describe('createRedisSchemaCache', () => {
  let fake: FakeRedis;

  beforeEach(() => {
    fake = makeFakeRedis();
  });

  it('returns undefined on cache miss', async () => {
    const cache = createRedisSchemaCache<string>(asRedis(fake), {
      ttlMs: 60_000,
      namespace: 'snow-mcp:test',
    });
    const result = await cache.get('missing-key');
    expect(result).toBeUndefined();
  });

  it('returns parsed value on cache hit', async () => {
    fake.store.set('snow-mcp:test:mykey', { value: JSON.stringify({ x: 1 }) });
    const cache = createRedisSchemaCache<{ x: number }>(asRedis(fake), {
      ttlMs: 60_000,
      namespace: 'snow-mcp:test',
    });
    const result = await cache.get('mykey');
    expect(result).toEqual({ x: 1 });
  });

  it('stores JSON with TTL passed through to redis.set', async () => {
    const cache = createRedisSchemaCache<{ y: number }>(asRedis(fake), {
      ttlMs: 30_000,
      namespace: 'snow-mcp:test',
    });
    await cache.set('mykey', { y: 42 });
    expect(fake.set).toHaveBeenCalledWith('snow-mcp:test:mykey', JSON.stringify({ y: 42 }), {
      EX: 30,
    });
  });

  it('uses namespaced key format ${namespace}:${key}', async () => {
    const cache = createRedisSchemaCache<string>(asRedis(fake), {
      ttlMs: 60_000,
      namespace: DESCRIBE_CACHE_NAMESPACE,
    });
    await cache.set('incident', 'data');
    expect(fake.set).toHaveBeenCalledWith(
      `${DESCRIBE_CACHE_NAMESPACE}:incident`,
      expect.any(String),
      expect.any(Object),
    );
  });

  it('get returns undefined when ttlMs <= 0 (disabled)', async () => {
    const cache = createRedisSchemaCache<string>(asRedis(fake), {
      ttlMs: 0,
      namespace: 'snow-mcp:test',
    });
    const result = await cache.get('any-key');
    expect(result).toBeUndefined();
    expect(fake.get).not.toHaveBeenCalled();
  });

  it('set is a no-op when ttlMs <= 0', async () => {
    const cache = createRedisSchemaCache<string>(asRedis(fake), {
      ttlMs: 0,
      namespace: 'snow-mcp:test',
    });
    await cache.set('k', 'v');
    expect(fake.set).not.toHaveBeenCalled();
  });

  it('get returns undefined (fail-open) when Redis throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.get.mockRejectedValueOnce(new Error('connection refused'));
    const cache = createRedisSchemaCache<string>(asRedis(fake), {
      ttlMs: 60_000,
      namespace: 'snow-mcp:test',
    });
    const result = await cache.get('k');
    expect(result).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('set resolves (fail-open) when Redis throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.set.mockRejectedValueOnce(new Error('connection refused'));
    const cache = createRedisSchemaCache<string>(asRedis(fake), {
      ttlMs: 60_000,
      namespace: 'snow-mcp:test',
    });
    await expect(cache.set('k', 'v')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
