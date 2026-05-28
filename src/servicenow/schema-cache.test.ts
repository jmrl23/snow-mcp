import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createSchemaCache } from './schema-cache.js';

describe('createSchemaCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns set value on get within ttl', async () => {
    const cache = createSchemaCache<number>({ ttlMs: 1000, maxEntries: 10 });
    await cache.set('a', 1);
    expect(await cache.get('a')).toBe(1);
  });

  it('returns undefined when entry has expired', async () => {
    const cache = createSchemaCache<number>({ ttlMs: 1000, maxEntries: 10 });
    await cache.set('a', 1);
    vi.advanceTimersByTime(1001);
    expect(await cache.get('a')).toBeUndefined();
  });

  it('expires entry at the exact ttl boundary (>= semantics)', async () => {
    const cache = createSchemaCache<number>({ ttlMs: 1000, maxEntries: 10 });
    await cache.set('a', 1);
    vi.advanceTimersByTime(1000);
    expect(await cache.get('a')).toBeUndefined();
  });

  it('evicts oldest entry when maxEntries is reached', async () => {
    const cache = createSchemaCache<number>({ ttlMs: 60_000, maxEntries: 2 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.set('c', 3);
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('b')).toBe(2);
    expect(await cache.get('c')).toBe(3);
  });

  it('refreshes insertion order on overwrite so re-set keys are not evicted first', async () => {
    const cache = createSchemaCache<number>({ ttlMs: 60_000, maxEntries: 2 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.set('a', 11); // refreshes 'a'
    await cache.set('c', 3); // should evict 'b', not 'a'
    expect(await cache.get('a')).toBe(11);
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('c')).toBe(3);
  });

  it('treats ttlMs:0 as disabled (get always undefined, set is a no-op)', async () => {
    const cache = createSchemaCache<number>({ ttlMs: 0, maxEntries: 10 });
    await cache.set('a', 1);
    expect(await cache.get('a')).toBeUndefined();
  });

  it('clear() removes a previously-set key', async () => {
    const cache = createSchemaCache<number>({ ttlMs: 1000, maxEntries: 10 });
    await cache.set('a', 1);
    await cache.clear();
    expect(await cache.get('a')).toBeUndefined();
  });

  it('clear() removes a second previously-set key', async () => {
    const cache = createSchemaCache<number>({ ttlMs: 1000, maxEntries: 10 });
    await cache.set('b', 2);
    await cache.clear();
    expect(await cache.get('b')).toBeUndefined();
  });
});
