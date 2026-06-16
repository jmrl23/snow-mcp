import { LRUCache } from 'lru-cache';

export interface SchemaCacheOptions {
  ttlMs: number;
  maxEntries: number;
}

export interface SchemaCache<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  clear(): Promise<void>;
}

export function createNoopSchemaCache<T>(): SchemaCache<T> {
  return {
    async get() {
      return undefined;
    },
    async set() {},
    async clear() {},
  };
}

export function createSchemaCache<T>(opts: SchemaCacheOptions): SchemaCache<T> {
  if (opts.ttlMs <= 0) return createNoopSchemaCache<T>();

  const cache = new LRUCache<string, { v: T }>({
    max: opts.maxEntries,
    ttl: opts.ttlMs,
    perf: { now: () => Date.now() },
  });

  return {
    async get(key) {
      // NOTE: undefined-safe wrapper — lru-cache uses undefined as "not found" sentinel
      return cache.get(key)?.v;
    },
    async set(key, value) {
      cache.set(key, { v: value });
    },
    async clear() {
      cache.clear();
    },
  };
}
