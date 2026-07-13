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

/**
 * Tautulli's `get_history` rows carry NO library field at all — not `library_name`,
 * not `section_id` (verified against a live server; the row keys are date, duration,
 * full_title, media_type, rating_key, user … and nothing library-shaped). The importer
 * read `r.library_name` anyway, which is always undefined, so 99% of imported plays
 * landed with a null library and the analytics "Libraries" report attributed nearly
 * everything to one "Unknown" bucket (7,972 of 8,057 rows on one host; 17,025 of 17,062
 * on another).
 *
 * The only thing that knows a row's library is the SECTION we filtered by. So we ask
 * per section and stamp the name onto the rows that come back.
 */
describe('TautulliAnalyticsImportProvider — libraries', () => {
  const ctx = { baseUrl: 'http://tautulli:8181', apiKey: 'k' } as any;
  const provider = new TautulliAnalyticsImportProvider();

  const mockApi = (byCmd: Record<string, unknown>) => {
    (global as any).fetch = jest.fn(async (url: string) => {
      const cmd = new URL(url).searchParams.get('cmd')!;
      const sectionId = new URL(url).searchParams.get('section_id');
      const key = sectionId ? `${cmd}:${sectionId}` : cmd;
      return { ok: true, json: async () => ({ response: { data: byCmd[key] ?? byCmd[cmd] } }) };
    });
  };

  const HISTORY_ROW = {
    row_id: 1, user_id: 7, friendly_name: 'dennis', full_title: 'Ted Lasso - Pilot',
    media_type: 'episode', started: 1700000000, stopped: 1700001800, duration: 1800,
    percent_complete: 100, transcode_decision: 'direct play',
    // NOTE: no library_name, no section_id — exactly what Tautulli returns.
  };

  it('lists the source’s libraries', async () => {
    mockApi({
      get_libraries: [
        { section_id: 5, section_name: 'Movies: HD', section_type: 'movie' },
        { section_id: 7, section_name: 'TV Shows', section_type: 'show' },
        { section_id: null, section_name: 'broken' }, // skipped
      ],
    });
    expect(await provider.getLibraries(ctx)).toEqual([
      { sectionId: '5', name: 'Movies: HD', type: 'movie' },
      { sectionId: '7', name: 'TV Shows', type: 'show' },
    ]);
  });

  it('stamps the library onto history fetched for that section', async () => {
    mockApi({ 'get_history:7': { data: [HISTORY_ROW], recordsFiltered: 1 } });
    const page = await provider.getWatchHistory(ctx, {
      start: 0, length: 100, sectionId: '7', libraryName: 'TV Shows',
    });
    // The row itself has no library — this is the ONLY place it can come from.
    expect(page.records[0].libraryName).toBe('TV Shows');
    expect(page.total).toBe(1);
  });

  it('passes section_id to Tautulli so the history is actually filtered', async () => {
    mockApi({ 'get_history:5': { data: [HISTORY_ROW], recordsFiltered: 1 } });
    await provider.getWatchHistory(ctx, { start: 0, length: 100, sectionId: '5', libraryName: 'Movies: HD' });
    const url = ((global as any).fetch as jest.Mock).mock.calls[0][0] as string;
    expect(new URL(url).searchParams.get('section_id')).toBe('5');
  });

  it('leaves the library null on an unfiltered fetch — those rows have no library', async () => {
    // Clips, live TV, a since-deleted section: genuinely no library. Null is honest.
    mockApi({ get_history: { data: [HISTORY_ROW], recordsFiltered: 1 } });
    const page = await provider.getWatchHistory(ctx, { start: 0, length: 100 });
    expect(page.records[0].libraryName).toBeUndefined();
    const url = ((global as any).fetch as jest.Mock).mock.calls[0][0] as string;
    expect(new URL(url).searchParams.has('section_id')).toBe(false);
  });
});
