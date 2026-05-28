import type { RedisClientType } from 'redis';
import type { SchemaCache } from './schema-cache.js';
import { redactSecrets } from '../log-redact.js';

export interface RedisSchemaCacheOptions {
  ttlMs: number;
  namespace: string;
}

// NOTE: createClient() returns RedisClientType<RedisDefaultModules & M, ...> which is not
// assignable to RedisClientType<M, ...>. Using Pick narrows to the operations we actually
// call, which both the real client and test fakes satisfy without casts.
type RedisOps = Pick<RedisClientType, 'get' | 'set' | 'scan' | 'del'>;

// NOTE: No app-side LRU here. Redis handles eviction via maxmemory-policy — that is an operator concern.
export function createRedisSchemaCache<T>(
  redis: RedisOps,
  opts: RedisSchemaCacheOptions,
): SchemaCache<T> {
  const { ttlMs, namespace } = opts;
  const disabled = ttlMs <= 0;

  function namespacedKey(key: string): string {
    return `${namespace}:${key}`;
  }

  return {
    async get(key) {
      if (disabled) return undefined;
      try {
        const raw = await redis.get(namespacedKey(key));
        if (raw === null) return undefined;
        return JSON.parse(raw) as T;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[snow-mcp] Redis get error:', redactSecrets(msg));
        return undefined;
      }
    },

    async set(key, value) {
      if (disabled) return;
      try {
        await redis.set(namespacedKey(key), JSON.stringify(value), {
          EX: Math.ceil(ttlMs / 1000),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[snow-mcp] Redis set error:', redactSecrets(msg));
      }
    },

    async clear() {
      try {
        const pattern = `${namespace}:*`;
        let cursor = '0';
        do {
          const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
          cursor = result.cursor;
          if (result.keys.length > 0) {
            await redis.del(result.keys);
          }
        } while (cursor !== '0');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[snow-mcp] Redis clear error:', redactSecrets(msg));
      }
    },
  };
}
