import { AcquisitionMatchPreferenceService } from '../acquisition-match-preference.service';
import type { MatchCandidateInput } from '../../rss/match-engine';
import type { IndexerCandidate } from '../../indexers/torznab-client';

const svc = new AcquisitionMatchPreferenceService(null as any);

const cand = (over: Partial<IndexerCandidate>): IndexerCandidate => ({
  indexerId: 'ix',
  indexerName: 'ix',
  title: 'The Show S01E01 1080p WEB-DL x265-GRP',
  downloadUrl: 'magnet:?xt=urn:btih:aaa',
  infoHash: null,
  sizeBytes: null,
  seeders: null,
  categories: [],
  ...over,
});

const pref = (over: Partial<MatchCandidateInput>): MatchCandidateInput => ({
  id: 'p',
  name: 'p',
  priorityOrder: 0,
  enabled: true,
  matchType: 'smart_episode_match',
  pattern: null,
  requiredTerms: [],
  excludedTerms: [],
  qualityRules: {},
  sizeRules: {},
  ...over,
});

const GB = 1024 * 1024 * 1024;

describe('AcquisitionMatchPreferenceService.select', () => {
  const prefs1080 = [pref({ name: '1080p x265 ≤1GB', qualityRules: { resolution: '1080p', codec: 'x265' }, sizeRules: { maxBytes: GB } })];

  it('rejects a release over the size cap, keeps one under it', () => {
    const big = cand({ downloadUrl: 'magnet:big', sizeBytes: 2 * GB });
    const small = cand({ downloadUrl: 'magnet:small', sizeBytes: 700 * 1024 * 1024 });
    const res = svc.select([big, small], prefs1080, 'The Show', 1, 1);
    expect(res).not.toBeNull();
    expect(res!.candidate.downloadUrl).toBe('magnet:small'); // the big one is over the 1GB cap
  });

  it('returns null when every release is over the cap', () => {
    const big = cand({ sizeBytes: 3 * GB });
    expect(svc.select([big], prefs1080, 'The Show', 1, 1)).toBeNull();
  });

  it('prefers the higher-priority candidate (1080p over 720p)', () => {
    const prefs = [
      pref({ id: 'a', priorityOrder: 0, name: '1080p x265', qualityRules: { resolution: '1080p', codec: 'x265' } }),
      pref({ id: 'b', priorityOrder: 1, name: '720p x265', qualityRules: { resolution: '720p', codec: 'x265' } }),
    ];
    const p720 = cand({ downloadUrl: 'magnet:720', title: 'The Show S01E01 720p WEB-DL x265-GRP', sizeBytes: 300 * 1024 * 1024 });
    const p1080 = cand({ downloadUrl: 'magnet:1080', title: 'The Show S01E01 1080p WEB-DL x265-GRP', sizeBytes: 800 * 1024 * 1024 });
    const res = svc.select([p720, p1080], prefs, 'The Show', 1, 1);
    expect(res!.candidate.downloadUrl).toBe('magnet:1080');
  });

  it('rejects a non-preferred codec (x264 when x265 required)', () => {
    const x264 = cand({ title: 'The Show S01E01 1080p WEB-DL x264-GRP', sizeBytes: 500 * 1024 * 1024 });
    expect(svc.select([x264], prefs1080, 'The Show', 1, 1)).toBeNull();
  });

  it('filters to the exact SxxEyy of the wanted episode', () => {
    const wrongEp = cand({ title: 'The Show S01E02 1080p WEB-DL x265-GRP', sizeBytes: 500 * 1024 * 1024 });
    expect(svc.select([wrongEp], prefs1080, 'The Show', 1, 1)).toBeNull();
  });

  it('skips candidates without a download URL', () => {
    const noUrl = cand({ downloadUrl: null, sizeBytes: 500 * 1024 * 1024 });
    expect(svc.select([noUrl], prefs1080, 'The Show', 1, 1)).toBeNull();
  });

  it('accepts a release whose size is unknown (size rule skipped, not blocked)', () => {
    const unknownSize = cand({ sizeBytes: null });
    const res = svc.select([unknownSize], prefs1080, 'The Show', 1, 1);
    expect(res).not.toBeNull();
  });
});
