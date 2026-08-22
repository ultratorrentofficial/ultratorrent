import { EngineTorrentCache } from './engine-torrent.cache';

/**
 * The cache exists so a reader never has to ask the engine a second time, so
 * what matters is that it tells the truth about *when* it last looked and never
 * outlives what it describes.
 */

const t = (hash: string) => ({ hash, name: hash, engineId: 'e1' }) as never;
const stats = { downloadRate: 10, uploadRate: 5 } as never;

describe('EngineTorrentCache', () => {
  it('returns null for an engine that has never been polled', () => {
    // Not an empty list: "nobody has looked" and "there are no torrents" are
    // different facts, and a consumer showing zero for the first is lying.
    expect(new EngineTorrentCache().get('e1')).toBeNull();
  });

  it('keeps each engine separate', () => {
    const cache = new EngineTorrentCache();
    cache.record('e1', '2026-08-22T00:00:00.000Z', [t('a')], stats);
    cache.record('e2', '2026-08-22T00:00:01.000Z', [t('b'), t('c')], stats);

    expect(cache.get('e1')!.torrents).toHaveLength(1);
    expect(cache.get('e2')!.torrents).toHaveLength(2);
    expect(cache.list()).toHaveLength(2);
  });

  it('replaces a reading wholesale rather than merging it', () => {
    // A removed torrent has to disappear. A merge would keep it visible for the
    // life of the process.
    const cache = new EngineTorrentCache();
    cache.record('e1', '2026-08-22T00:00:00.000Z', [t('a'), t('b')], stats);
    cache.record('e1', '2026-08-22T00:00:02.000Z', [t('a')], stats);

    const reading = cache.get('e1')!;
    expect(reading.torrents.map((x) => (x as { hash: string }).hash)).toEqual(['a']);
    expect(reading.at).toBe('2026-08-22T00:00:02.000Z');
  });

  it('carries the timestamp of the reading, not of the read', () => {
    const cache = new EngineTorrentCache();
    cache.record('e1', '2026-08-22T12:00:00.000Z', [], stats);
    expect(cache.get('e1')!.at).toBe('2026-08-22T12:00:00.000Z');
  });

  it('accepts a reading whose stats the engine would not give', () => {
    const cache = new EngineTorrentCache();
    cache.record('e1', '2026-08-22T00:00:00.000Z', [t('a')], null);
    expect(cache.get('e1')!.stats).toBeNull();
    expect(cache.get('e1')!.torrents).toHaveLength(1);
  });

  it('forgets an engine on request, and only that engine', () => {
    const cache = new EngineTorrentCache();
    cache.record('e1', '2026-08-22T00:00:00.000Z', [t('a')], stats);
    cache.record('e2', '2026-08-22T00:00:00.000Z', [t('b')], stats);

    cache.forget('e1');

    expect(cache.get('e1')).toBeNull();
    expect(cache.get('e2')).not.toBeNull();
  });

  it('forgetting an engine that was never recorded is not an error', () => {
    expect(() => new EngineTorrentCache().forget('nope')).not.toThrow();
  });
});
