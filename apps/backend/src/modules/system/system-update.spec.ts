import { parseVersion, compareParts } from './system-update.service';

describe('system-update version helpers', () => {
  it('parses v-prefixed and bare release tags', () => {
    expect(parseVersion('v0.12.0')).toEqual([0, 12, 0]);
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
  });

  it('rejects non-release tags', () => {
    expect(parseVersion('v0.12')).toBeNull();
    expect(parseVersion('nightly')).toBeNull();
    expect(parseVersion('v1.2.3-rc1')).toBeNull();
  });

  it('orders versions by major, then minor, then patch', () => {
    expect(compareParts([0, 13, 0], [0, 12, 0])).toBeGreaterThan(0);
    expect(compareParts([1, 0, 0], [0, 99, 99])).toBeGreaterThan(0);
    expect(compareParts([0, 12, 1], [0, 12, 0])).toBeGreaterThan(0);
    expect(compareParts([0, 12, 0], [0, 12, 0])).toBe(0);
    expect(compareParts([0, 12, 0], [0, 13, 0])).toBeLessThan(0);
  });

  it('picks the newest tag from a mixed, unsorted list', () => {
    const tags = ['v0.11.8', 'v0.12.0', 'v0.9.0', 'nightly', 'v0.11.10'];
    let best: number[] | null = null;
    for (const t of tags) {
      const p = parseVersion(t);
      if (p && (!best || compareParts(p, best) > 0)) best = p;
    }
    expect(best).toEqual([0, 12, 0]);
  });
});
