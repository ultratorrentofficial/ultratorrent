import { originalBackupPath } from './subtitle-sync.service';
import { FfsubsyncProvider } from './ffsubsync.provider';

describe('originalBackupPath', () => {
  it('inserts .orig before the extension', () => {
    expect(originalBackupPath('/media/Movie (2020).en.srt')).toBe('/media/Movie (2020).en.orig.srt');
    expect(originalBackupPath('/tv/Show.S01E01.es-PR.ass')).toBe('/tv/Show.S01E01.es-PR.orig.ass');
  });
});

describe('FfsubsyncProvider', () => {
  const p = new FfsubsyncProvider();

  it('names itself and starts with no known version', () => {
    expect(p.name).toBe('ffsubsync');
    expect(p.version).toBeNull(); // only known after a successful isAvailable() probe
  });

  it('returns a neutral analysis', async () => {
    expect(await p.analyze({ videoPath: '/x.mkv', content: '', format: 'srt' })).toEqual({
      offsetMs: 0,
      driftFactor: 1,
      confidence: null,
    });
  });

  it('validates a sync by non-empty output', () => {
    expect(p.validateSync({ content: 'x', offsetMs: 0, driftFactor: 1, confidence: null, method: 'audio' })).toBe(true);
    expect(p.validateSync({ content: '   ', offsetMs: 0, driftFactor: 1, confidence: null, method: 'audio' })).toBe(false);
  });

  it('isAvailable resolves to a boolean without throwing', async () => {
    await expect(p.isAvailable()).resolves.toEqual(expect.any(Boolean));
  });
});
