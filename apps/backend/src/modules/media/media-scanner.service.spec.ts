import { isIgnoredScanDir, deriveFileTechInfo } from './media-scanner.service';
import { parseItemIdentity } from './media-identification.service';

describe('isIgnoredScanDir', () => {
  it('skips hidden/dot directories (trash + sidecar metadata)', () => {
    expect(isIgnoredScanDir('.deletedByTMM')).toBe(true);
    expect(isIgnoredScanDir('.actors')).toBe(true);
    expect(isIgnoredScanDir('.Trashes')).toBe(true);
  });

  it('skips Synology @eaDir thumbnail folders', () => {
    expect(isIgnoredScanDir('@eaDir')).toBe(true);
  });

  it('keeps normal library folders', () => {
    expect(isIgnoredScanDir('Breaking Bad')).toBe(false);
    expect(isIgnoredScanDir('Season 01')).toBe(false);
    expect(isIgnoredScanDir('HD Movies')).toBe(false);
  });
});

describe('deriveFileTechInfo', () => {
  it('derives container + quality from a release filename', () => {
    const info = deriveFileTechInfo('/x/Show.S01E01.1080p.WEB-DL.x264-GRP.mkv');
    expect(info.container).toBe('mkv');
    expect(info.resolution).toBe('1080p');
    expect(info.videoCodec).toBe('x264');
    expect(info.releaseGroup).toBe('GRP');
  });
});

// The identity the scanner now stores on a new item, instead of the raw filename.
describe('parseItemIdentity (what the scanner stores)', () => {
  const LIB = '/downloads/TV';

  it('stores the series + season/episode, not the filename (Blindspot regression)', () => {
    const id = parseItemIdentity(
      `${LIB}/TV_Shows/Blindspot (2015)/Season 1/Blindspot - S01E14 - Rules in Defiance.mp4`,
      LIB,
    );
    expect(id.title).toBe('Blindspot'); // was: "Blindspot - S01E14 - Rules in Defiance"
    expect(id.season).toBe(1);
    expect(id.episode).toBe(14);
  });

  it('takes the series from the show folder when the filename is only the episode name', () => {
    const id = parseItemIdentity(
      `${LIB}/9-1-1 (2018)/Season 9/Contraband Seized at the Border - S09E04.mkv`,
      LIB,
    );
    expect(id.title).toBe('9-1-1'); // folder wins; filename names the *episode*
    expect(id.season).toBe(9);
    expect(id.episode).toBe(4);
  });

  it('keeps the filename title for a loose scene release (folder is a junk/download dir)', () => {
    const id = parseItemIdentity(`${LIB}/completed/Show.Name.S02E05.1080p.WEB.x265-GRP.mkv`, LIB);
    expect(id.title).toBe('Show Name');
    expect(id.season).toBe(2);
    expect(id.episode).toBe(5);
  });

  it('leaves a movie without season/episode', () => {
    const id = parseItemIdentity(`${LIB}/../Movies/Dune Part Two (2024)/Dune Part Two (2024) [1080p].mkv`, LIB);
    expect(id.season).toBeNull();
    expect(id.episode).toBeNull();
  });
});
