import { NOTIFICATION_EVENTS } from '@ultratorrent/shared';
import { readdir, stat } from 'node:fs/promises';
import { MissingEpisodeSearchService } from '../missing-episode-search.service';
import type { IndexerCandidate } from '../../indexers/torznab-client';

// resolveSavePath reads the library directory to see whether the show already has
// a folder there (under any spelling) before it is allowed to create a new one, and
// stats the folders an IMDb id points at to drop ones that no longer exist.
jest.mock('node:fs/promises', () => ({
  readdir: jest.fn(async () => []),
  stat: jest.fn(async () => ({ isDirectory: () => true })),
}));

const cand = (over: Partial<IndexerCandidate> = {}): IndexerCandidate => ({
  indexerId: 'ix', indexerName: 'ix',
  title: 'The Wire S01E01 1080p WEB-DL x265-GRP',
  downloadUrl: 'magnet:?xt=urn:btih:aaaa', infoHash: 'aaaa',
  sizeBytes: 1_000_000_000, seeders: 100, categories: [5030], ...over,
});

const selection = (c: IndexerCandidate) => ({ candidate: c, matchedPriority: 0, reason: 'matched “1080p x265 (≤1 GB)”' });

function build(over: {
  candidates?: IndexerCandidate[];
  selected?: any; // pass `null` to force no-match; omit to auto-select the first candidate
  evaluation?: any;
  settings?: Record<string, unknown>;
  enabled?: boolean;
  wanted?: Record<string, unknown>;
  item?: Record<string, unknown>;
  rssRule?: Record<string, unknown> | null;
  rules?: Array<{ name: string; savePath: string | null }>;
  existingItem?: { path: string } | null;
  /** Library items, as (title, path) — what the title-match step scans. */
  libraryItems?: Array<{ title: string; path: string }>;
  /** The library item carrying the wanted episode's IMDb id, if any. */
  imdbItem?: { path: string } | null;
  /** Several library items sharing that IMDb id — i.e. mis-tagged metadata. */
  imdbItems?: Array<{ path: string }>;
  /** Show folders that do NOT exist on disk (a stale library row). */
  missingDirs?: string[];
  /** Directory names sitting in the library on disk. */
  libraryDirs?: string[];
  library?: { path: string } | null;
} = {}) {
  const wanted = {
    id: 'w1', watchlistItemId: 'wl1', seriesTconst: 'ttS', seasonNumber: 1, episodeNumber: 1,
    status: 'missing', searchStatus: 'idle', lastSearchedAt: null, ...over.wanted,
  };
  const updates: any[] = [];
  const prisma = {
    wantedEpisode: {
      findMany: jest.fn(async () => [wanted]),
      findUnique: jest.fn(async ({ where }: any) => (where.id === wanted.id ? wanted : null)),
      update: jest.fn(async ({ data }: any) => { updates.push(data); return { ...wanted, ...data }; }),
      // setState uses updateMany (no-throw on a vanished row); track it like update.
      updateMany: jest.fn(async ({ data }: any) => { updates.push(data); return { count: 1 }; }),
    },
    mediaAcquisitionWatchlistItem: {
      findUnique: jest.fn(async () => ({ id: 'wl1', title: 'The Wire', normalizedTitle: 'the wire', year: null, targetLibraryId: null, priority: 100, rssRuleId: null, ...over.item })),
    },
    rssRule: {
      findUnique: jest.fn(async () => ('rssRule' in over ? over.rssRule : { savePath: '/media/tv/The Wire' })),
      findMany: jest.fn(async () => over.rules ?? []),
    },
    mediaItem: {
      findFirst: jest.fn(async () => over.existingItem ?? null),
      // The title-match step pulls one row per distinct show title. `existingItem`
      // is the legacy shorthand: a library row for the default show under test.
      findMany: jest.fn(async () =>
        over.libraryItems ??
        (over.existingItem ? [{ title: 'The Wire', path: over.existingItem.path }] : []),
      ),
    },
    mediaExternalId: {
      findMany: jest.fn(async () => {
        const items = over.imdbItems ?? (over.imdbItem ? [over.imdbItem] : []);
        return items.map((i) => ({ item: { path: i.path } }));
      }),
    },
    mediaLibrary: {
      // A configured install always has a TV library, so a save path always
      // resolves; pass `library: null` to model the unconfigured case.
      findUnique: jest.fn(async () => ('library' in over ? over.library : { path: '/media/tv' })),
      findFirst: jest.fn(async () => ('library' in over ? over.library : { path: '/media/tv' })),
    },
  };
  (readdir as jest.Mock).mockImplementation(async () =>
    (over.libraryDirs ?? []).map((name) => ({ name, isDirectory: () => true })),
  );
  // Every folder exists unless the test says otherwise.
  (stat as jest.Mock).mockImplementation(async (p: string) => {
    if ((over.missingDirs ?? []).includes(p)) throw new Error('ENOENT');
    return { isDirectory: () => true };
  });

  const indexers = { searchAll: jest.fn(async () => over.candidates ?? []) };
  const evaluator = { grabSelected: jest.fn(async () => over.evaluation ?? { id: 'ev1' }) };
  const matchPrefs = {
    resolveCandidates: jest.fn(async () => []),
    select: jest.fn((candidates: IndexerCandidate[]) => {
      if ('selected' in over) return over.selected;
      return candidates.length ? selection(candidates[0]) : null;
    }),
  };
  const acquisition = {
    getSettings: jest.fn(async () => ({
      autoSearchMissing: true, searchIntervalMinutes: 60, missingSearchProfileId: null, maxSearchesPerSweep: 50,
      ...over.settings,
    })),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const realtime = { broadcast: jest.fn() };
  const eventBus = { emit: jest.fn() };
  const registry = { getStatus: jest.fn(() => ({ enabled: over.enabled ?? true })) };
  const svc = new MissingEpisodeSearchService(
    prisma as any, indexers as any, evaluator as any, matchPrefs as any, acquisition as any,
    audit as any, realtime as any, eventBus as any, registry as any,
  );
  return { svc, prisma, indexers, evaluator, matchPrefs, acquisition, audit, realtime, eventBus, updates };
}

describe('MissingEpisodeSearchService.sweep — gating', () => {
  it('no-ops when the module is disabled', async () => {
    const { svc, evaluator, acquisition } = build({ enabled: false });
    expect(await svc.sweep()).toBeNull();
    expect(acquisition.getSettings).not.toHaveBeenCalled();
    expect(evaluator.grabSelected).not.toHaveBeenCalled();
  });

  it('no-ops when autoSearchMissing is off', async () => {
    const { svc, evaluator } = build({ settings: { autoSearchMissing: false } });
    expect(await svc.sweep()).toBeNull();
    expect(evaluator.grabSelected).not.toHaveBeenCalled();
  });
});

describe('MissingEpisodeSearchService.sweep — grab flow', () => {
  it('grabs the release the match preferences selected', async () => {
    const { svc, updates, evaluator, matchPrefs, eventBus, realtime } = build({ candidates: [cand()] });
    const summary = await svc.sweep();
    expect(summary).toMatchObject({ scanned: 1, grabbed: 1 });
    // preferences decided the pick; grabSelected got the release + magnet + source.
    expect(matchPrefs.select).toHaveBeenCalled();
    expect(evaluator.grabSelected).toHaveBeenCalledWith(
      expect.objectContaining({
        releaseName: 'The Wire S01E01 1080p WEB-DL x265-GRP',
        downloadUrl: 'magnet:?xt=urn:btih:aaaa',
        sourceType: 'missing_episode_sweep',
        sourceId: 'w1',
        reason: expect.stringContaining('1080p'),
      }),
      undefined,
    );
    const last = updates[updates.length - 1];
    expect(last).toMatchObject({ searchStatus: 'grabbed', grabbedEvaluationId: 'ev1', releaseTitle: 'The Wire S01E01 1080p WEB-DL x265-GRP' });
    expect(eventBus.emit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ event: NOTIFICATION_EVENTS.MEDIA_MISSING_EPISODE_FILLED }));
    expect(realtime.broadcast).toHaveBeenCalledWith('media_acquisition.missing_episode.grabbed', expect.anything());
  });

  it('grabs into the parent Show Rule save path when the show is linked to an RSS rule', async () => {
    const { svc, evaluator, prisma } = build({
      candidates: [cand()],
      item: { rssRuleId: 'rule1' },
      rssRule: { savePath: '/media/tv/The Wire' },
    });
    await svc.sweep();
    expect(prisma.rssRule.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rule1' } }),
    );
    expect(evaluator.grabSelected).toHaveBeenCalledWith(
      expect.objectContaining({ savePath: '/media/tv/The Wire' }),
      undefined,
    );
  });

  it('falls back to the library show folder when the show has no RSS rule', async () => {
    const { svc, evaluator, prisma } = build({ candidates: [cand()] });
    await svc.sweep();
    expect(prisma.rssRule.findUnique).not.toHaveBeenCalled();
    expect(evaluator.grabSelected).toHaveBeenCalledWith(
      expect.objectContaining({ savePath: '/media/tv/The Wire' }),
      undefined,
    );
  });

  it('falls past a linked Show Rule with an empty save path to the library folder', async () => {
    const { svc, evaluator } = build({
      candidates: [cand()],
      item: { rssRuleId: 'rule1' },
      rssRule: { savePath: '   ' },
    });
    await svc.sweep();
    expect(evaluator.grabSelected).toHaveBeenCalledWith(
      expect.objectContaining({ savePath: '/media/tv/The Wire' }),
      undefined,
    );
  });

  it('refuses the grab rather than dropping the episode in the engine default root', async () => {
    // No rule, no existing folder, no TV library → nothing to place the file in.
    // Grabbing anyway would scatter loose files at the download root.
    const { svc, evaluator, updates, audit, eventBus } = build({ candidates: [cand()], library: null });
    const summary = await svc.sweep();
    expect(evaluator.grabSelected).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ grabbed: 0 });
    expect(updates[updates.length - 1]).toMatchObject({ searchStatus: 'failed' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'media_acquisition.missing_episode.no_save_path' }),
    );
  });

  // --- layered fallback when the show is NOT linked to an RSS rule -------------
  it('falls back to an RSS rule matched by the show title (unlinked show)', async () => {
    const { svc, evaluator } = build({
      candidates: [cand()],
      rules: [
        { name: 'Some Other Show', savePath: '/x' },
        { name: 'The Wire', savePath: '/media/tv/The Wire (2002)' },
      ],
    });
    await svc.sweep();
    expect(evaluator.grabSelected).toHaveBeenCalledWith(
      expect.objectContaining({ savePath: '/media/tv/The Wire (2002)' }),
      undefined,
    );
  });

  it("falls back to the show's existing library folder (past a Season NN container)", async () => {
    const { svc, evaluator } = build({
      candidates: [cand()],
      existingItem: { path: '/downloads/TV Shows/The Wire (2002)/Season 01/The Wire - S01E01.mkv' },
    });
    await svc.sweep();
    expect(evaluator.grabSelected).toHaveBeenCalledWith(
      expect.objectContaining({ savePath: '/downloads/TV Shows/The Wire (2002)' }),
      undefined,
    );
  });

  it('constructs <TV library>/<Title> (Year) when there is no rule or existing folder', async () => {
    const { svc, evaluator } = build({
      candidates: [cand()],
      item: { year: 2002 },
      library: { path: '/downloads/TV Shows/' },
    });
    await svc.sweep();
    expect(evaluator.grabSelected).toHaveBeenCalledWith(
      expect.objectContaining({ savePath: '/downloads/TV Shows/The Wire (2002)' }),
      undefined,
    );
  });
});

/**
 * Two duplicate watchlist entries for the same show — titled "Ghosts 2021" and
 * "Ghosts (US)" — each minted their own folder beside the real
 * `TV Shows/Ghosts US (2021)`, because every lookup demanded exact string equality
 * and the RSS rule was named plain "Ghosts". The chain must find the show that is
 * already on disk, whatever the entry happens to be called.
 */
describe('MissingEpisodeSearchService — save path never invents a duplicate show folder', () => {
  const GHOSTS_DIR = '/downloads/TV Shows/Ghosts US (2021)';
  const ghosts = (title: string, over: Record<string, unknown> = {}) => ({
    candidates: [cand()],
    item: { title, year: 2021, ...over },
    wanted: { seriesTconst: 'tt11379026' },
    library: { path: '/downloads/TV Shows' },
  });
  const savedTo = (evaluator: any) => evaluator.grabSelected.mock.calls[0][0].savePath;

  it('matches the rule named "Ghosts" for an entry titled "Ghosts 2021" (trailing year ignored)', async () => {
    const { svc, evaluator } = build({
      ...ghosts('Ghosts 2021'),
      rules: [{ name: 'Ghosts', savePath: GHOSTS_DIR }],
    });
    await svc.sweep();
    expect(savedTo(evaluator)).toBe(GHOSTS_DIR);
  });

  it('finds the library folder by IMDb id when the title matches nothing', async () => {
    const { svc, evaluator } = build({
      ...ghosts('Ghosts (US)'),
      rules: [{ name: 'Ghosts', savePath: null }], // rule exists but carries no path
      imdbItem: { path: `${GHOSTS_DIR}/Season 05/Ghosts.2021.S05E12.mkv` },
      libraryDirs: ['Ghosts US (2021)'],
    });
    await svc.sweep();
    expect(savedTo(evaluator)).toBe(GHOSTS_DIR);
  });

  it('reuses a show folder that already exists on disk rather than inventing one', async () => {
    // No rule, no IMDb hit, no library row — only the directory itself. Punctuation
    // differs ("Ghosts (US)" vs "Ghosts US (2021)"); it must still be recognised.
    const { svc, evaluator } = build({
      ...ghosts('Ghosts (US)'),
      libraryDirs: ['Breaking Bad (2008)', 'Ghosts US (2021)', 'The Wire (2002)'],
    });
    await svc.sweep();
    expect(savedTo(evaluator)).toBe(GHOSTS_DIR);
    expect(savedTo(evaluator)).not.toBe('/downloads/TV Shows/Ghosts (US) (2021)');
  });

  it('both duplicate entries resolve to the SAME folder — the original bug', async () => {
    // The real failure: two watchlist entries, differently titled, SAME show —
    // both carried seriesTconst tt11379026, and the library folder does too. The
    // id is what unifies them; "Ghosts 2021" (key "ghosts") could never be matched
    // to the folder "Ghosts US (2021)" (key "ghosts us") on titles alone, and
    // stretching the title match far enough to do so is how "Rise" once swallowed
    // "Rise of the Merlin".
    const shared = {
      libraryDirs: ['Ghosts US (2021)'],
      imdbItem: { path: `${GHOSTS_DIR}/Season 05/Ghosts.2021.S05E12.mkv` },
    };
    const a = build({ ...ghosts('Ghosts 2021'), ...shared });
    await a.svc.sweep();
    const b = build({ ...ghosts('Ghosts (US)'), ...shared });
    await b.svc.sweep();
    expect(savedTo(a.evaluator)).toBe(GHOSTS_DIR);
    expect(savedTo(b.evaluator)).toBe(GHOSTS_DIR);
  });

  it('falls back to creating a folder when the show carries no identity at all', async () => {
    // Honest limit of the hardening: no rule, no IMDb id, and a folder name that is
    // not canonically the title. A new folder is created rather than guessing — a
    // stray folder is recoverable, filing episodes into the wrong show is not.
    const { svc, evaluator } = build({
      ...ghosts('Ghosts 2021'),
      wanted: { seriesTconst: null },
      libraryDirs: ['Ghosts US (2021)'],
    });
    await svc.sweep();
    expect(savedTo(evaluator)).toBe('/downloads/TV Shows/Ghosts 2021 (2021)');
  });

  it('does NOT collapse a genuinely different show onto it (Ghosts UK ≠ Ghosts US)', async () => {
    const { svc, evaluator } = build({
      ...ghosts('Ghosts UK', { year: 2019 }),
      libraryDirs: ['Ghosts US (2021)'],
    });
    await svc.sweep();
    // Canonical EQUALITY, not substring: "ghosts uk" never answers to "ghosts us".
    expect(savedTo(evaluator)).toBe('/downloads/TV Shows/Ghosts UK (2019)');
  });

  it('still creates a folder for a show that genuinely is not in the library yet', async () => {
    const { svc, evaluator } = build({
      ...ghosts('Some New Show', { year: 2026 }),
      libraryDirs: ['Ghosts US (2021)'],
    });
    await svc.sweep();
    expect(savedTo(evaluator)).toBe('/downloads/TV Shows/Some New Show (2026)');
  });

  it('an alias on the watchlist entry also finds the folder', async () => {
    const { svc, evaluator } = build({
      ...ghosts('Ghosts', { titleAliases: ['Ghosts US'] }),
      libraryDirs: ['Ghosts US (2021)'],
    });
    await svc.sweep();
    expect(savedTo(evaluator)).toBe(GHOSTS_DIR);
  });

  it('ignores a stale library row pointing at a folder that no longer exists', async () => {
    // The library still has rows for the deleted "Ghosts 2021 (2021)". Only the
    // folder that survives on disk may be used.
    const { svc, evaluator } = build({
      ...ghosts('Ghosts (US)'),
      imdbItems: [
        { path: '/downloads/TV Shows/Ghosts 2021 (2021)/Ghosts.2021.S01E13.mkv' },
        { path: `${GHOSTS_DIR}/Season 05/Ghosts.2021.S05E12.mkv` },
      ],
      missingDirs: ['/downloads/TV Shows/Ghosts 2021 (2021)'],
      libraryDirs: ['Ghosts US (2021)'],
    });
    await svc.sweep();
    expect(savedTo(evaluator)).toBe(GHOSTS_DIR);
  });

  it('an apostrophe-less title still finds the folder (Happys Place → Happy’s Place)', async () => {
    // Release names carry "Happys.Place", so the watchlist entry does too — while the
    // library folder is "Happy's Place (2024)". Treating the apostrophe as a separator
    // ("happy s place") is what let a stray "Happys Place" folder be created.
    const { svc, evaluator } = build({
      candidates: [cand()],
      item: { title: 'Happys Place', year: 2024 },
      wanted: { seriesTconst: null },
      library: { path: '/downloads/TV Shows' },
      libraryDirs: ["Happy's Place (2024)"],
    });
    await svc.sweep();
    expect(savedTo(evaluator)).toBe("/downloads/TV Shows/Happy's Place (2024)");
  });

  it('a missing dot still finds the folder (Magnum P.I → Magnum P.I.)', async () => {
    const { svc, evaluator } = build({
      candidates: [cand()],
      item: { title: 'Magnum P.I', year: 2018 },
      wanted: { seriesTconst: null },
      library: { path: '/downloads/TV Shows' },
      libraryDirs: ['Magnum P.I. (2018)'],
    });
    await svc.sweep();
    expect(savedTo(evaluator)).toBe('/downloads/TV Shows/Magnum P.I. (2018)');
  });

  it('refuses to trust an IMDb id that is mis-tagged onto two different shows', async () => {
    // Real corruption found on synoplex: "Masters of the Air" carries High Desert's
    // tt13701758. Trusting the id would file High Desert's episodes into the Masters
    // of the Air folder. The id is ambiguous → fall through to the title.
    const { svc, evaluator } = build({
      candidates: [cand()],
      item: { title: 'High Desert', year: 2023 },
      wanted: { seriesTconst: 'tt13701758' },
      library: { path: '/downloads/TV Shows' },
      imdbItems: [
        { path: '/downloads/TV Shows/High Desert (2023)/Season 1/High Desert - S01E01.mp4' },
        { path: '/downloads/TV Shows/Masters of the Air (2024)/Season 1/Masters of the Air - S01E01.mkv' },
      ],
      libraryDirs: ['High Desert (2023)', 'Masters of the Air (2024)'],
    });
    await svc.sweep();
    expect(savedTo(evaluator)).toBe('/downloads/TV Shows/High Desert (2023)');
    expect(savedTo(evaluator)).not.toContain('Masters of the Air');
  });
});

describe('MissingEpisodeSearchService.sweep — resilience', () => {
  it('does not abort the tick when a wanted row vanished mid-sweep (setState no-ops, not throws)', async () => {
    const { svc, prisma } = build({ candidates: [cand()] });
    // A concurrent library/watchlist scan deleted+recreated the rows: writes now
    // match nothing. updateMany returns count 0 instead of throwing.
    prisma.wantedEpisode.updateMany = jest.fn(async (_args: any) => ({ count: 0 }));
    // Guard against a regression to `update`, which WOULD throw "record not found".
    prisma.wantedEpisode.update = jest.fn(async (_args: any) => { throw new Error('Record to update not found'); });
    const summary = await svc.sweep();
    expect(summary).toMatchObject({ scanned: 1 }); // tick completed, not aborted
    expect(prisma.wantedEpisode.update).not.toHaveBeenCalled();
  });

  it('records no_results and never grabs when nothing matches the preferences', async () => {
    const { svc, updates, evaluator, eventBus } = build({ candidates: [cand()], selected: null });
    const summary = await svc.sweep();
    expect(summary).toMatchObject({ noResults: 1, grabbed: 0 });
    expect(evaluator.grabSelected).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(updates[updates.length - 1]).toMatchObject({ searchStatus: 'no_results' });
  });
});

describe('MissingEpisodeSearchService — manual triggers', () => {
  it('searchEpisode rejects an episode that is not missing', async () => {
    const { svc } = build({ wanted: { status: 'owned' } });
    await expect(svc.searchEpisode('w1')).rejects.toThrow(/not missing/i);
  });

  it('searchEpisode rejects when the module is disabled', async () => {
    const { svc } = build({ enabled: false });
    await expect(svc.searchEpisode('w1')).rejects.toThrow(/disabled/i);
  });
});
