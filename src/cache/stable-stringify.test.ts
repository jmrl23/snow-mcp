import { describe, expect, it } from 'vitest';
import { stableStringify } from './stable-stringify.js';

describe('stableStringify', () => {
  it('produces identical output regardless of object key order', () => {
    const a = stableStringify({ table: 'incident', sys_id: 'abc' });
    const b = stableStringify({ sys_id: 'abc', table: 'incident' });
    expect(a).toBe(b);
  });

  it('normalises key order in nested objects', () => {
    const a = stableStringify({ outer: { z: 1, a: 2 } });
    const b = stableStringify({ outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it('preserves array element order', () => {
    const out = stableStringify({ fields: ['b', 'a'] });
    expect(out).toBe('{"fields":["b","a"]}');
  });

  it('omits keys whose value is undefined, matching JSON.stringify', () => {
    const out = stableStringify({ table: 'incident', filter: undefined });
    expect(out).toBe('{"table":"incident"}');
  });

  it('serialises primitives directly', () => {
    expect(stableStringify('incident')).toBe('"incident"');
  });
});
