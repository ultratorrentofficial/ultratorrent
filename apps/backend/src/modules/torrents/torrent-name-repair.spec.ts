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
    const svc = new TorrentNameRepairService();
    const renameTorrent = jest.fn();
    const getFiles = jest.fn().mockResolvedValue([]); // no metadata yet
    const provider = { getFiles, renameTorrent } as never;

    await svc.repair(provider, [torrent()]);
    expect(renameTorrent).not.toHaveBeenCalled();

    // Not marked settled — a later tick tries again (the magnet may resolve).
    await svc.repair(provider, [torrent()]);
    expect(getFiles).toHaveBeenCalledTimes(2);
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
