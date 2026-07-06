import {
  normalizeTautulliHistory,
  normalizeBaseUrl,
  getAnalyticsImportProvider,
  TautulliAnalyticsImportProvider,
} from './analytics-import-provider';

describe('analytics import provider', () => {
  it('resolves the Tautulli provider and rejects unknown', () => {
    expect(getAnalyticsImportProvider('tautulli')).toBeInstanceOf(TautulliAnalyticsImportProvider);
    expect(() => getAnalyticsImportProvider('plex')).toThrow(/Unsupported analytics import/);
  });

  describe('normalizeBaseUrl', () => {
    it('defaults a scheme-less host to http://', () => {
      expect(normalizeBaseUrl('192.168.99.10:8181')).toBe('http://192.168.99.10:8181');
      expect(normalizeBaseUrl('tautulli:8181')).toBe('http://tautulli:8181');
    });

    it('preserves an explicit http/https scheme (case-insensitive)', () => {
      expect(normalizeBaseUrl('http://tautulli:8181')).toBe('http://tautulli:8181');
      expect(normalizeBaseUrl('https://tautulli.example.com')).toBe('https://tautulli.example.com');
      expect(normalizeBaseUrl('HTTPS://Host:8181')).toBe('HTTPS://Host:8181');
    });

    it('trims whitespace and trailing slashes', () => {
      expect(normalizeBaseUrl('  http://tautulli:8181/  ')).toBe('http://tautulli:8181');
      expect(normalizeBaseUrl('192.168.99.10:8181///')).toBe('http://192.168.99.10:8181');
    });
  });

  it('normalizes a Tautulli get_history row', () => {
    const n = normalizeTautulliHistory({
      row_id: 42,
      user_id: 7,
      friendly_name: 'Alice',
      full_title: 'The Show - Pilot',
      media_type: 'episode',
      library_name: 'TV',
      platform: 'Roku',
      player: 'Living Room',
      ip_address: '10.0.0.5',
      started: 1_700_000_000,
      stopped: 1_700_003_600,
      duration: 3600,
      percent_complete: 100,
      transcode_decision: 'transcode',
    });
    expect(n).toMatchObject({
      providerHistoryId: '42',
      providerUserId: '7',
      userName: 'Alice',
      title: 'The Show - Pilot',
      mediaType: 'episode',
      libraryName: 'TV',
      device: 'Roku',
      client: 'Living Room',
      watchedSeconds: 3600,
      percentComplete: 100,
      playbackMethod: 'transcode',
    });
    expect(n.startedAt.getTime()).toBe(1_700_000_000 * 1000);
    expect(n.stoppedAt?.getTime()).toBe(1_700_003_600 * 1000);
  });

  it('maps direct play / copy decisions', () => {
    expect(normalizeTautulliHistory({ started: 1, transcode_decision: 'direct play' }).playbackMethod).toBe('directplay');
    expect(normalizeTautulliHistory({ started: 1, transcode_decision: 'copy' }).playbackMethod).toBe('directstream');
  });

  it('falls back to a synthetic id when row_id is missing', () => {
    const n = normalizeTautulliHistory({ user_id: 3, started: 1700, full_title: 'X' });
    expect(n.providerHistoryId).toBe('3-1700');
  });
});
