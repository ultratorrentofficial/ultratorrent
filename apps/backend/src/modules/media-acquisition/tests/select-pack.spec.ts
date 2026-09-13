import { AcquisitionMatchPreferenceService } from '../acquisition-match-preference.service';

// selectPack is pure (no prisma access), so a bare instance is enough.
const svc = new AcquisitionMatchPreferenceService({} as never);
// A permissive quality preference (no rules → matches any release).
const prefs = [{ id: 'p', name: 'any', priorityOrder: 0, enabled: true, matchType: 'wildcard' as const, pattern: '*' }];
const cand = (title: string, over: Record<string, unknown> = {}) => ({
  indexerId: 'i', indexerName: 'X', title, downloadUrl: 'magnet:x', infoHash: null,
  sizeBytes: 5_000_000_000, seeders: 10, categories: [5000], ...over,
});

describe('AcquisitionMatchPreferenceService.selectPack', () => {
  it('selects a season pack matching the target season and title', () => {
    const best = svc.selectPack([cand('Vikings S03 1080p WEB-DL x264-GRP')], prefs, 'Vikings', { type: 'season', season: 3 }, 30 * 1024 ** 3);
    expect(best?.candidate.title).toContain('S03');
  });

  it('ignores a single episode and the wrong season', () => {
    const cands = [cand('Vikings S03E01 1080p'), cand('Vikings S02 1080p')];
    expect(svc.selectPack(cands, prefs, 'Vikings', { type: 'season', season: 3 }, 30 * 1024 ** 3)).toBeNull();
  });

  it('rejects a pack over the size cap', () => {
    const big = cand('Vikings S03 1080p', { sizeBytes: 40 * 1024 ** 3 });
    expect(svc.selectPack([big], prefs, 'Vikings', { type: 'season', season: 3 }, 30 * 1024 ** 3)).toBeNull();
  });

  it('rejects a different show', () => {
    expect(svc.selectPack([cand('Gotham S03 1080p')], prefs, 'Vikings', { type: 'season', season: 3 }, 30 * 1024 ** 3)).toBeNull();
  });

  it('accepts a complete-series pack for a series target', () => {
    const best = svc.selectPack([cand('Vikings The Complete Series 1080p')], prefs, 'Vikings', { type: 'series', seasons: [1, 2, 3] }, 150 * 1024 ** 3);
    expect(best).not.toBeNull();
  });

  it('rejects a series range that does not cover every needed season', () => {
    expect(svc.selectPack([cand('Vikings S01-S02 1080p')], prefs, 'Vikings', { type: 'series', seasons: [1, 4] }, 150 * 1024 ** 3)).toBeNull();
  });
});
