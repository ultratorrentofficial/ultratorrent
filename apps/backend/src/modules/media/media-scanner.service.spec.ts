import { isIgnoredScanDir, deriveFileTechInfo } from './media-scanner.service';

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
