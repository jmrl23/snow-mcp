import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const CACHE_KINDS = [
  'schema',
  'catalog',
  'user_context',
  'record',
  'aggregate',
  'report',
] as const;

export type CacheKind = (typeof CACHE_KINDS)[number];

type CacheTier = 'long' | 'medium' | 'short';

const KIND_TIER: Record<CacheKind, CacheTier> = {
  schema: 'long',
  catalog: 'long',
  user_context: 'medium',
  record: 'short',
  aggregate: 'short',
  report: 'short',
};

export interface ResourceCacheOptions {
  dbPath: string;
  ttlLongMs: number;
  ttlMediumMs: number;
  ttlShortMs: number;
  maxEntries: number;
}

export interface ResourceCache {
  get<T>(kind: CacheKind, key: string): Promise<T | undefined>;
  set<T>(kind: CacheKind, key: string, value: T): Promise<void>;
  clear(kind?: CacheKind): Promise<number>;
}

export function createNoopResourceCache(): ResourceCache {
  return {
    async get() {
      return undefined;
    },
    async set() {},
    async clear() {
      return 0;
    },
  };
}

export function createResourceCache(opts: ResourceCacheOptions): ResourceCache {
  const tierTtl: Record<CacheTier, number> = {
    long: opts.ttlLongMs,
    medium: opts.ttlMediumMs,
    short: opts.ttlShortMs,
  };
  if (tierTtl.long <= 0 && tierTtl.medium <= 0 && tierTtl.short <= 0) {
    return createNoopResourceCache();
  }

  if (opts.dbPath !== ':memory:') {
    mkdirSync(dirname(opts.dbPath), { recursive: true });
  }

  const db = new DatabaseSync(opts.dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      key        TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      value      TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cache_kind ON cache_entries(kind);
    CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries(expires_at);
  `);

  const selectStmt = db.prepare('SELECT value, expires_at FROM cache_entries WHERE key = ?');
  const deleteKeyStmt = db.prepare('DELETE FROM cache_entries WHERE key = ?');
  const deleteExpiredStmt = db.prepare('DELETE FROM cache_entries WHERE expires_at < ?');
  const upsertStmt = db.prepare(
    'INSERT OR REPLACE INTO cache_entries (key, kind, value, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const countStmt = db.prepare('SELECT COUNT(*) as n FROM cache_entries');
  const deleteOldestStmt = db.prepare(
    'DELETE FROM cache_entries WHERE key IN (SELECT key FROM cache_entries ORDER BY created_at ASC, rowid ASC LIMIT ?)',
  );
  const deleteAllStmt = db.prepare('DELETE FROM cache_entries WHERE 1 = 1');
  const deleteByKindStmt = db.prepare('DELETE FROM cache_entries WHERE kind = ?');

  function storageKey(kind: CacheKind, key: string): string {
    return `${kind}:${key}`;
  }

  return {
    async get<T>(kind: CacheKind, key: string): Promise<T | undefined> {
      if (tierTtl[KIND_TIER[kind]] <= 0) return undefined;
      const storedKey = storageKey(kind, key);
      const row = selectStmt.get(storedKey) as { value: string; expires_at: number } | undefined;
      if (!row) return undefined;
      if (row.expires_at < Date.now()) {
        deleteKeyStmt.run(storedKey);
        return undefined;
      }
      return JSON.parse(row.value) as T;
    },
    async set<T>(kind: CacheKind, key: string, value: T): Promise<void> {
      const ttl = tierTtl[KIND_TIER[kind]];
      if (ttl <= 0) return;
      const now = Date.now();
      // NOTE: sweep-on-write only, no setInterval — a lingering timer previously caused a stdin-close hang.
      deleteExpiredStmt.run(now);
      upsertStmt.run(storageKey(kind, key), kind, JSON.stringify(value), now + ttl, now);
      const countRow = countStmt.get() as { n: number };
      const overflow = Number(countRow.n) - opts.maxEntries;
      if (overflow > 0) {
        deleteOldestStmt.run(overflow);
      }
    },
    async clear(kind?: CacheKind): Promise<number> {
      const result = kind ? deleteByKindStmt.run(kind) : deleteAllStmt.run();
      return Number(result.changes);
    },
  };
}
