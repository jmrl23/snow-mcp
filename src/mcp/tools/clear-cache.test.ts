import { describe, expect, it } from 'vitest';
import { createClearCacheTool } from './clear-cache.js';
import { createResourceCache } from '../../cache/resource-cache.js';

const OPTS = {
  dbPath: ':memory:',
  ttlLongMs: 60_000,
  ttlMediumMs: 60_000,
  ttlShortMs: 60_000,
  maxEntries: 10,
};

describe('clear_cache tool', () => {
  it('clears everything and reports the count when no kind is given', async () => {
    const cache = createResourceCache(OPTS);
    await cache.set('schema', 'a', 1);
    await cache.set('record', 'b', 2);
    const tool = createClearCacheTool(cache);
    const out = await tool.handler({});
    const payload = JSON.parse((out.content?.[0] as { text: string }).text);
    expect(payload.clearedCount).toBe(2);
  });

  it('scopes the clear to the given kind', async () => {
    const cache = createResourceCache(OPTS);
    await cache.set('schema', 'a', 1);
    await cache.set('record', 'b', 2);
    const tool = createClearCacheTool(cache);
    await tool.handler({ kind: 'schema' });
    expect(await cache.get('record', 'b')).toBe(2);
  });

  it('leaves the scoped kind empty after clearing', async () => {
    const cache = createResourceCache(OPTS);
    await cache.set('schema', 'a', 1);
    const tool = createClearCacheTool(cache);
    await tool.handler({ kind: 'schema' });
    expect(await cache.get('schema', 'a')).toBeUndefined();
  });
});
