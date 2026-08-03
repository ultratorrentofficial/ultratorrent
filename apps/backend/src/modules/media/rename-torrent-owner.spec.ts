import { torrentsOwningPaths } from './rename-torrent-owner';
import type { NormalizedTorrent } from '@ultratorrent/shared';

/**
 * Which torrent was seeding the file a rename just moved.
 *
 * The action this feeds removes a torrent, so over-matching is the failure that
 * matters. The library on both live hosts sits INSIDE the download tree and
 * every film shares one `savePath` — so a rule that fell back to `savePath`
 * would name all 248 torrents as the owner of a single renamed file.
 */
const t = (over: Partial<NormalizedTorrent>): NormalizedTorrent => ({
  hash: 'h', name: 'n', state: 'seeding' as never, progress: 1, size: 1,
  downloaded: 1, uploaded: 0, ratio: 0, downloadRate: 0, uploadRate: 0, eta: null,
  seedsConnected: 0, seedsTotal: 0, peersConnected: 0, peersTotal: 0,
  priority: 'normal' as never, label: null,
  savePath: '/downloads/Movies/HD Movies', contentPath: '', isPrivate: false,
  message: null, addedAt: null, completedAt: null, engineId: 'e1',
  ...over,
});

const SAVE = '/downloads/Movies/HD Movies';

describe('torrentsOwningPaths', () => {
  it('matches the torrent whose contentPath contains the moved file', () => {
    const torrents = [
      t({ hash: 'aaa', name: 'A Sense Of Dread', contentPath: `${SAVE}/A Sense Of Dread (2026) [1080p]` }),
      t({ hash: 'bbb', name: 'Other Film', contentPath: `${SAVE}/Other Film (2025) [1080p]` }),
    ];
    const owners = torrentsOwningPaths(torrents, [`${SAVE}/A Sense Of Dread (2026) [1080p]/movie.mp4`]);
    expect(owners.map((o) => o.hash)).toEqual(['aaa']);
    expect(owners[0].paths).toHaveLength(1);
  });

  it('NEVER falls back to savePath, which every film in a library shares', () => {
    // The whole library shares this savePath. Matching on it would remove every
    // torrent in the library because one file was renamed.
    const torrents = [
      t({ hash: 'aaa', contentPath: '' }),
      t({ hash: 'bbb', contentPath: '' }),
      t({ hash: 'ccc', contentPath: '' }),
    ];
    expect(torrentsOwningPaths(torrents, [`${SAVE}/Some Film (2026)/movie.mp4`])).toEqual([]);
  });

  it('does not let one folder claim a similarly-named sibling', () => {
    // Prefix matching would have `Movie (2026)` swallow `Movie (2026) Extras`.
    const torrents = [t({ hash: 'aaa', contentPath: `${SAVE}/Movie (2026)` })];
    const owners = torrentsOwningPaths(torrents, [`${SAVE}/Movie (2026) Extras/bonus.mkv`]);
    expect(owners).toEqual([]);
  });

  it('matches a single-file torrent whose contentPath IS the file', () => {
    const file = `${SAVE}/Standalone (2026).mkv`;
    const torrents = [t({ hash: 'aaa', contentPath: file })];
    expect(torrentsOwningPaths(torrents, [file]).map((o) => o.hash)).toEqual(['aaa']);
  });

  it('uses a recorded hash even when no path matches', () => {
    // Provenance recorded at rename time is exact; a path comparison is not.
    const torrents = [t({ hash: 'aaa', contentPath: '/somewhere/else' })];
    const owners = torrentsOwningPaths(torrents, [`${SAVE}/x.mkv`], ['AAA']);
    expect(owners.map((o) => o.hash)).toEqual(['aaa']);
  });

  it('reports each torrent once however many of its files moved', () => {
    const dir = `${SAVE}/Pack (2026)`;
    const torrents = [t({ hash: 'aaa', contentPath: dir })];
    const owners = torrentsOwningPaths(torrents, [`${dir}/a.mkv`, `${dir}/b.mkv`, `${dir}/c.srt`]);
    expect(owners).toHaveLength(1);
    expect(owners[0].paths).toHaveLength(3);
  });

  it('returns nothing when no torrent owns the moved files', () => {
    const torrents = [t({ hash: 'aaa', contentPath: `${SAVE}/Unrelated (2020)` })];
    expect(torrentsOwningPaths(torrents, [`${SAVE}/Different (2026)/m.mkv`])).toEqual([]);
  });
});
