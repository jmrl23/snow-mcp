import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createSchemaCache } from './schema-cache.js';

describe('createSchemaCache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns set value on get within ttl', () => {
    const cache = createSchemaCache<number>({ ttlMs: 1000, maxEntries: 10 });
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
  });

  it('returns undefined when entry has expired', () => {
    const cache = createSchemaCache<number>({ ttlMs: 1000, maxEntries: 10 });
    cache.set('a', 1);
    vi.advanceTimersByTime(1001);
    expect(cache.get('a')).toBeUndefined();
  });

  it('expires entry at the exact ttl boundary (>= semantics)', () => {
    const cache = createSchemaCache<number>({ ttlMs: 1000, maxEntries: 10 });
    cache.set('a', 1);
    vi.advanceTimersByTime(1000);
    expect(cache.get('a')).toBeUndefined();
  });

  it('evicts oldest entry when maxEntries is reached', () => {
    const cache = createSchemaCache<number>({ ttlMs: 60_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('refreshes insertion order on overwrite so re-set keys are not evicted first', () => {
    const cache = createSchemaCache<number>({ ttlMs: 60_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 11); // refreshes 'a'
    cache.set('c', 3); // should evict 'b', not 'a'
    expect(cache.get('a')).toBe(11);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('treats ttlMs:0 as disabled (get always undefined, set is a no-op)', () => {
    const cache = createSchemaCache<number>({ ttlMs: 0, maxEntries: 10 });
    cache.set('a', 1);
    expect(cache.get('a')).toBeUndefined();
  });

  it('clear() removes a previously-set key', () => {
    const cache = createSchemaCache<number>({ ttlMs: 1000, maxEntries: 10 });
    cache.set('a', 1);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
  });

  it('clear() removes a second previously-set key', () => {
    const cache = createSchemaCache<number>({ ttlMs: 1000, maxEntries: 10 });
    cache.set('b', 2);
    cache.clear();
    expect(cache.get('b')).toBeUndefined();
  });
});
