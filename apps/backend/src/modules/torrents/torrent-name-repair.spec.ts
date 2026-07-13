import { TorrentNameRepairService } from './torrent-name-repair.service';

const HASH = '246c46439929e36f77561f3c3c62d5839acfcab6';

describe('TorrentNameRepairService.isPlaceholderName', () => {
  it('detects rTorrent\'s "<HASH>.meta" magnet placeholder, in either case', () => {
    expect(
      TorrentNameRepairService.isPlaceholderName(`${HASH.toUpperCase()}.meta`, HASH),
    ).toBe(true);
    expect(TorrentNameRepairService.isPlaceholderName(`${HASH}.meta`, HASH)).toBe(true);
  });

  it('detects a bare infohash, regardless of the case the engine reports', () => {
    expect(TorrentNameRepairService.isPlaceholderName(HASH, HASH)).toBe(true);
    expect(TorrentNameRepairService.isPlaceholderName(HASH.toUpperCase(), HASH)).toBe(true);
  });

  it('treats an empty name as a placeholder', () => {
    expect(TorrentNameRepairService.isPlaceholderName('', HASH)).toBe(true);
  });

  it('leaves real names alone — including ones that merely contain hex', () => {
    for (const name of [
      'Star.Wars.the.Bad.Batch.S03E02.1080p.HEVC.x265-MeGusta[EZTVx.to].mkv',
      'Dark Winds S03E08 1080p x265-ELiTE',
      'deadbeef.mkv',
      // 40 hex chars, but it is the *file*, not the torrent name — do not touch.
      `${HASH}.mkv`,
      // a different hash's name should still not be treated as this one's
      'abc123',
    ]) {
      expect(TorrentNameRepairService.isPlaceholderName(name, HASH)).toBe(false);
    }
  });
});

describe('TorrentNameRepairService.nameFromFiles', () => {
  it('uses the filename for a single-file torrent', () => {
    expect(TorrentNameRepairService.nameFromFiles(['Show.S01E01.mkv'])).toBe(
      'Show.S01E01.mkv',
    );
  });

  it('uses the shared root directory for a multi-file torrent', () => {
    expect(
      TorrentNameRepairService.nameFromFiles([
        'Show.S01.1080p/Show.S01E01.mkv',
        'Show.S01.1080p/Show.S01E02.mkv',
        'Show.S01.1080p/subs/eng.srt',
      ]),
    ).toBe('Show.S01.1080p');
  });

  it('refuses to guess when the paths do not share a root', () => {
    expect(
      TorrentNameRepairService.nameFromFiles(['a/one.mkv', 'b/two.mkv']),
    ).toBeNull();
  });

  it('returns null when the metadata has not arrived (no files)', () => {
    expect(TorrentNameRepairService.nameFromFiles([])).toBeNull();
  });

  it('normalises backslashes and leading slashes', () => {
    expect(
      TorrentNameRepairService.nameFromFiles(['/Pack\\a.mkv', '/Pack\\b.mkv']),
    ).toBe('Pack');
  });
});

describe('repair()', () => {
  const torrent = (over: Partial<{ hash: string; name: string }> = {}) =>
    ({ hash: HASH, name: `${HASH.toUpperCase()}.meta`, ...over }) as never;

  it('renames a placeholder to the real name derived from the file list', async () => {
    const svc = new TorrentNameRepairService();
    const renameTorrent = jest.fn().mockResolvedValue(undefined);
    const provider = {
      getFiles: jest.fn().mockResolvedValue([{ path: 'Real.Name.S01E01.mkv' }]),
      renameTorrent,
    } as never;

    await svc.repair(provider, [torrent()]);

    expect(renameTorrent).toHaveBeenCalledWith(HASH, 'Real.Name.S01E01.mkv');
  });

  it('leaves a magnet whose metadata has not arrived alone, and retries it later', async () => {
    jest.useFakeTimers();
    const svc = new TorrentNameRepairService();
    const renameTorrent = jest.fn();
    const getFiles = jest.fn().mockResolvedValue([]); // no metadata yet
    const provider = { getFiles, renameTorrent } as never;

    await svc.repair(provider, [torrent()]);
    expect(renameTorrent).not.toHaveBeenCalled();

    // NOT on the next tick. The sync loop runs every 2s and only takes 5 torrents a
    // pass, so re-checking a dead magnet immediately lets a pile of them consume the
    // whole budget and starve the repairable torrents behind them — which is exactly
    // what happened on a real host (221 dead magnets, 15 fixable, none ever fixed).
    await svc.repair(provider, [torrent()]);
    expect(getFiles).toHaveBeenCalledTimes(1);

    // It is NOT settled, though — the magnet may still resolve. After the backoff it
    // is looked at again.
    jest.advanceTimersByTime(5 * 60_000 + 1);
    await svc.repair(provider, [torrent()]);
    expect(getFiles).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('never touches a torrent that already has a real name', async () => {
    const svc = new TorrentNameRepairService();
    const provider = { getFiles: jest.fn(), renameTorrent: jest.fn() } as never;

    await svc.repair(provider, [torrent({ name: 'Perfectly.Good.Name.mkv' })]);

    expect((provider as unknown as { getFiles: jest.Mock }).getFiles).not.toHaveBeenCalled();
  });

  it('gives up on an engine that cannot rename, instead of retrying every tick', async () => {
    const svc = new TorrentNameRepairService();
    const renameTorrent = jest
      .fn()
      .mockRejectedValue(new Error('rTorrent does not support renaming a torrent'));
    const getFiles = jest.fn().mockResolvedValue([{ path: 'Real.mkv' }]);
    const provider = { getFiles, renameTorrent } as never;

    await svc.repair(provider, [torrent()]);
    await svc.repair(provider, [torrent()]);

    expect(renameTorrent).toHaveBeenCalledTimes(1); // settled after the failure
  });
});

/**
 * The repair runs inside the 2-second sync tick and only takes MAX_PER_TICK torrents
 * per pass. A magnet with no metadata yet cannot be renamed — there is nothing to
 * rename it *to* — but it must not be reconsidered on every tick, or a pile of dead
 * magnets consumes the entire budget forever and the repairable torrents behind them
 * are never reached.
 *
 * A real host had 221 metadata-less magnets sitting ahead of 15 fixable torrents.
 * Not one name was ever repaired.
 */
describe('TorrentNameRepairService.repair', () => {
  const hash = (n: number) => n.toString(16).padStart(40, '0');
  const placeholder = (n: number) => ({ hash: hash(n), name: `${hash(n)}.meta` });

  function build(opts: { withMetadata?: Set<string>; renameFails?: boolean; hangs?: boolean } = {}) {
    const renamed: Array<{ hash: string; name: string }> = [];
    const getFilesCalls: string[] = [];
    const provider = {
      getFiles: jest.fn(async (h: string) => {
        getFilesCalls.push(h);
        if (opts.hangs) return new Promise(() => {}) as any; // never settles
        // A metadata-less magnet reports no files at all.
        return opts.withMetadata?.has(h) ? [{ path: `Real.Show.${h.slice(0, 4)}.mkv` }] : [];
      }),
      renameTorrent: jest.fn(async (h: string, name: string) => {
        if (opts.renameFails) throw new Error('engine refused');
        renamed.push({ hash: h, name });
      }),
    };
    return { svc: new TorrentNameRepairService(), provider, renamed, getFilesCalls };
  }

  it('does not let metadata-less magnets starve the repairable ones', async () => {
    // 8 dead magnets FIRST, then one that can actually be repaired. MAX_PER_TICK is
    // 5, so the fixable torrent is out of reach on the first pass.
    const dead = [0, 1, 2, 3, 4, 5, 6, 7].map(placeholder);
    const fixable = placeholder(99);
    const torrents = [...dead, fixable] as any[];
    const { svc, provider, renamed } = build({ withMetadata: new Set([fixable.hash]) });

    await svc.repair(provider as any, torrents); // tick 1: only the dead ones fit
    expect(renamed).toHaveLength(0);

    await svc.repair(provider as any, torrents); // tick 2
    await svc.repair(provider as any, torrents); // tick 3

    // Backed off, the dead magnets no longer occupy the budget — so the repairable
    // torrent is reached. Before the fix this looped on the same 5 forever.
    expect(renamed).toHaveLength(1);
    expect(renamed[0].hash).toBe(fixable.hash);
    expect(renamed[0].name).toBe(`Real.Show.${fixable.hash.slice(0, 4)}.mkv`);
  });

  it('stops re-fetching a metadata-less magnet on every tick', async () => {
    const dead = placeholder(1);
    const { svc, provider, getFilesCalls } = build();

    await svc.repair(provider as any, [dead] as any[]);
    await svc.repair(provider as any, [dead] as any[]);
    await svc.repair(provider as any, [dead] as any[]);

    // Looked at once, then backed off — not once per 2-second tick.
    expect(getFilesCalls).toEqual([dead.hash]);
  });

  it('renames a torrent whose metadata has arrived, and never revisits it', async () => {
    const t = placeholder(7);
    const { svc, provider, renamed, getFilesCalls } = build({ withMetadata: new Set([t.hash]) });

    await svc.repair(provider as any, [t] as any[]);
    await svc.repair(provider as any, [t] as any[]);

    expect(renamed).toHaveLength(1);
    expect(getFilesCalls).toHaveLength(1); // settled — not retried
  });

  it('gives up on a torrent whose engine refuses the rename', async () => {
    const t = placeholder(3);
    const { svc, provider, getFilesCalls } = build({ withMetadata: new Set([t.hash]), renameFails: true });

    await svc.repair(provider as any, [t] as any[]);
    await svc.repair(provider as any, [t] as any[]);

    expect(getFilesCalls).toHaveLength(1); // settled after the failure, not retried
  });

  it('times out a hanging engine call instead of wedging the sync tick', async () => {
    // The tick's re-entrancy guard resets in a `finally`. An engine call that never
    // settles means the guard is never cleared and the whole sync loop dies silently.
    jest.useFakeTimers();
    const t = placeholder(5);
    const { svc, provider } = build({ hangs: true });

    const done = svc.repair(provider as any, [t] as any[]);
    await jest.advanceTimersByTimeAsync(11_000);
    await expect(done).resolves.toBeUndefined(); // returned, did not hang
    jest.useRealTimers();
  });
});
