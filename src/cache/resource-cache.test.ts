import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResourceCache, createNoopResourceCache } from './resource-cache.js';

const BASE_OPTS = {
  dbPath: ':memory:',
  ttlLongMs: 1000,
  ttlMediumMs: 1000,
  ttlShortMs: 1000,
  maxEntries: 10,
};

describe('createResourceCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns set value on get within ttl', async () => {
    const cache = createResourceCache(BASE_OPTS);
    await cache.set('schema', 'incident', { label: 'Incident' });
    expect(await cache.get('schema', 'incident')).toEqual({ label: 'Incident' });
  });

  it('returns undefined when entry has expired', async () => {
    const cache = createResourceCache(BASE_OPTS);
    await cache.set('record', 'a', 1);
    vi.advanceTimersByTime(1001);
    expect(await cache.get('record', 'a')).toBeUndefined();
  });

  it('is still valid at the exact ttl boundary', async () => {
    const cache = createResourceCache(BASE_OPTS);
    await cache.set('record', 'a', 1);
    vi.advanceTimersByTime(1000);
    expect(await cache.get('record', 'a')).toBe(1);
  });

  it('disabling the short tier does not affect the long tier', async () => {
    const cache = createResourceCache({ ...BASE_OPTS, ttlShortMs: 0 });
    await cache.set('schema', 'a', 'kept');
    expect(await cache.get('schema', 'a')).toBe('kept');
  });

  it('disabling the short tier makes the record kind a no-op', async () => {
    const cache = createResourceCache({ ...BASE_OPTS, ttlShortMs: 0 });
    await cache.set('record', 'a', 'dropped');
    expect(await cache.get('record', 'a')).toBeUndefined();
  });

  it('different kinds do not collide on the same raw key', async () => {
    const cache = createResourceCache(BASE_OPTS);
    await cache.set('schema', 'x', 'schema-value');
    await cache.set('record', 'x', 'record-value');
    expect(await cache.get('schema', 'x')).toBe('schema-value');
  });

  it('clear(kind) removes only that kind', async () => {
    const cache = createResourceCache(BASE_OPTS);
    await cache.set('schema', 'a', 1);
    await cache.set('record', 'b', 2);
    await cache.clear('schema');
    expect(await cache.get('record', 'b')).toBe(2);
  });

  it('clear(kind) empties the cleared kind', async () => {
    const cache = createResourceCache(BASE_OPTS);
    await cache.set('schema', 'a', 1);
    await cache.clear('schema');
    expect(await cache.get('schema', 'a')).toBeUndefined();
  });

  it('clear() with no kind removes every entry', async () => {
    const cache = createResourceCache(BASE_OPTS);
    await cache.set('schema', 'a', 1);
    await cache.set('record', 'b', 2);
    await cache.clear();
    expect(await cache.get('record', 'b')).toBeUndefined();
  });

  it('clear() returns the number of rows removed', async () => {
    const cache = createResourceCache(BASE_OPTS);
    await cache.set('schema', 'a', 1);
    await cache.set('record', 'b', 2);
    expect(await cache.clear()).toBe(2);
  });

  it('evicts the oldest entry when maxEntries is exceeded', async () => {
    const cache = createResourceCache({ ...BASE_OPTS, maxEntries: 2 });
    await cache.set('schema', 'a', 1);
    vi.advanceTimersByTime(1);
    await cache.set('schema', 'b', 2);
    vi.advanceTimersByTime(1);
    await cache.set('schema', 'c', 3);
    expect(await cache.get('schema', 'a')).toBeUndefined();
  });

  it('keeps the newest entries after eviction', async () => {
    const cache = createResourceCache({ ...BASE_OPTS, maxEntries: 2 });
    await cache.set('schema', 'a', 1);
    vi.advanceTimersByTime(1);
    await cache.set('schema', 'b', 2);
    vi.advanceTimersByTime(1);
    await cache.set('schema', 'c', 3);
    expect(await cache.get('schema', 'c')).toBe(3);
  });

  it('returns a no-op cache when every tier ttl is 0', async () => {
    const cache = createResourceCache({
      ...BASE_OPTS,
      ttlLongMs: 0,
      ttlMediumMs: 0,
      ttlShortMs: 0,
    });
    await cache.set('schema', 'a', 1);
    expect(await cache.get('schema', 'a')).toBeUndefined();
  });

  it('creates the parent directory when the db file path does not exist yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resource-cache-'));
    const dbPath = join(dir, 'nested', 'cache.sqlite');
    createResourceCache({ ...BASE_OPTS, dbPath });
    expect(existsSync(dbPath)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('createNoopResourceCache', () => {
  it('get always returns undefined even after set', async () => {
    const cache = createNoopResourceCache();
    await cache.set('schema', 'a', 1);
    expect(await cache.get('schema', 'a')).toBeUndefined();
  });

  it('clear resolves to 0', async () => {
    const cache = createNoopResourceCache();
    await expect(cache.clear()).resolves.toBe(0);
  });
});
