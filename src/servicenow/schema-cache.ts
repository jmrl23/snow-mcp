export interface SchemaCacheOptions {
  ttlMs: number;
  maxEntries: number;
}

export interface SchemaCache<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  clear(): Promise<void>;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export function createSchemaCache<T>(opts: SchemaCacheOptions): SchemaCache<T> {
  const store = new Map<string, Entry<T>>();
  const disabled = opts.ttlMs <= 0;

  return {
    async get(key) {
      if (disabled) return undefined;
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() >= entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    async set(key, value) {
      if (disabled) return;
      if (store.has(key)) store.delete(key);
      store.set(key, { value, expiresAt: Date.now() + opts.ttlMs });
      while (store.size > opts.maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    async clear() {
      store.clear();
    },
  };
}
