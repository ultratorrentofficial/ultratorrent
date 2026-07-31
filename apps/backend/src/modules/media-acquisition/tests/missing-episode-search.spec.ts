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
  /** Health of the indexer fan-out — e.g. `{ queried: 2, failed: 2 }` for a total outage. */
  indexerRun?: { queried?: number; failed?: number; failures?: Array<{ name: string; message: string }> };
  selected?: any; // pass `null` to force no-match; omit to auto-select the first candidate
  evaluation?: any;
  /** Candidates keyed by the exact query string an indexer would answer. */
  candidatesByQuery?: Record<string, IndexerCandidate[]>;
  /** The hash the engine returned for the grabbed torrent. */
  torrentHash?: string | null;
  /** Storage profile behind a managed_intake rule; pass `null` for "none resolved". */
  profile?: { id: string; stagingRoot: string } | null;
  settings?: Record<string, unknown>;
  enabled?: boolean;
  wanted?: Record<string, unknown>;
  item?: Record<string, unknown>;
  rssRule?: Record<string, unknown> | null;
  rules?: Array<{ id?: string; name: string; savePath: string | null; importMode?: string; storageProfileId?: string | null }>;
  existingItem?: { path: string } | null;
  /** Library items, as (title, path) — what the title-match step scans. */
  libraryItems?: Array<{ title: string; path: string }>;
  /** The library item carrying the wanted episode's IMDb id, if any. */
  imdbItem?: { path: string } | null;
  /** Several library items sharing that IMDb id — i.e. mis-tagged metadata. */
  imdbItems?: Array<{ path: string }>;
  /** Show folders that do NOT exist on disk (a stale library row). */
  missingDirs?: string[];
  /** The MediaShow row the watchlist item is bound to (pass null to model a dangling FK). */
  libraryShow?: { path: string; title: string } | null;
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
    mediaShow: {
      findUnique: jest.fn(async () => ('libraryShow' in over ? over.libraryShow : null)),
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

  // The service reads the DETAILED run so it can tell a total indexer outage from an
  // honestly-empty catalogue. `indexerRun` overrides the health of that run; by
  // default every indexer answered successfully.
  const indexers = {
    // `candidatesByQuery` models a real indexer: it answers only the spelling it
    // actually holds, so a test can assert WHICH query found the release.
    searchAllDetailed: jest.fn(async ({ q }: { q: string }) => ({
      candidates: over.candidatesByQuery
        ? (over.candidatesByQuery[q] ?? [])
        : (over.candidates ?? []),
      queried: 1,
      failed: 0,
      failures: [],
      ...(over.indexerRun ?? {}),
    })),
  };
  const evaluator = {
    grabSelected: jest.fn(async () => ({
      evaluation: over.evaluation ?? { id: 'ev1' },
      // `in` not `??`: an explicit null means "the engine accepted no torrent",
      // which is the case under test, and ?? would silently substitute a hash.
      torrentHash: 'torrentHash' in over ? over.torrentHash : 'hash-1',
    })),
  };
  // Storage profiles only matter for a managed_intake rule; the default answers
  // with a staging root so those paths can be asserted.
  const profiles = {
    get: jest.fn(async () => over.profile ?? { id: 'p1', stagingRoot: '/media/staging' }),
    defaultProfile: jest.fn(async () =>
      over.profile === undefined ? { id: 'p1', stagingRoot: '/media/staging' } : over.profile),
  };
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
    audit as any, realtime as any, registry as any, profiles as any,
  );
  return { svc, prisma, indexers, evaluator, matchPrefs, acquisition, audit, realtime, eventBus, updates, profiles };
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

  it('the show’s RULE outranks even a bound library show', async () => {
    /*
     * The operator configured a rule for this show; that is a deliberate statement
     * about where it belongs, and acquisitions follow it. Previously the library
     * binding won and the rule was only consulted for shows the library had never
     * seen — which meant converting a rule to managed intake silently did nothing
     * for every show already on disk.
     */
    const { svc, evaluator } = build({
      ...ghosts('Ghosts 2021'),
      item: { title: 'Ghosts 2021', year: 2021, libraryShowId: 'show-1' },
      libraryShow: { path: GHOSTS_DIR, title: 'Ghosts US' },
      rules: [{ name: 'Ghosts 2021', savePath: '/downloads/TV Shows/From The Rule' }],
    });
    await svc.sweep();
    expect(savedTo(evaluator)).toBe('/downloads/TV Shows/From The Rule');
  });

  it('ignores a rule whose savePath no longer exists, and uses the binding', async () => {
    /*
     * A savePath left behind by a rename points somewhere nothing scans. Honouring
     * it blindly would recreate a dead folder and quietly file episodes into it, so
     * a stale rule loses to the path the scanner actually observed.
     */
    const { svc, evaluator } = build({
      ...ghosts('Ghosts 2021'),
      item: { title: 'Ghosts 2021', year: 2021, libraryShowId: 'show-1' },
      libraryShow: { path: GHOSTS_DIR, title: 'Ghosts US' },
      rules: [{ name: 'Ghosts 2021', savePath: '/downloads/TV Shows/RENAMED AWAY' }],
      missingDirs: ['/downloads/TV Shows/RENAMED AWAY'],
    });
    await svc.sweep();
    expect(savedTo(evaluator)).toBe(GHOSTS_DIR);
  });

  it('still uses the binding when the show has no rule at all', async () => {
    // The library-observed chain is unchanged for everything the rule step skips.
    const { svc, evaluator, prisma } = build({
      ...ghosts('Ghosts 2021'),
      item: { title: 'Ghosts 2021', year: 2021, libraryShowId: 'show-1' },
      libraryShow: { path: GHOSTS_DIR, title: 'Ghosts US' },
      rules: [],
      libraryDirs: ['Ghosts 2021 (2021)'],
    });
    await svc.sweep();
    expect(savedTo(evaluator)).toBe(GHOSTS_DIR);
    expect(prisma.mediaExternalId.findMany).not.toHaveBeenCalled();
  });

  it('sends a MANAGED_INTAKE rule’s grab to the staging root, not the library', async () => {
    /*
     * The point of the whole exercise: once a rule is converted, its missing-episode
     * grabs must stage like its RSS grabs do. If this resolved to the library the
     * two subsystems would file the same show in two different places.
     */
    const { svc, evaluator } = build({
      ...ghosts('Ghosts 2021'),
      item: { title: 'Ghosts 2021', year: 2021, libraryShowId: 'show-1' },
      libraryShow: { path: GHOSTS_DIR, title: 'Ghosts US' },
      rules: [{ id: 'rule-1', name: 'Ghosts 2021', savePath: GHOSTS_DIR, importMode: 'managed_intake' }],
    });
    await svc.sweep();
    // Per-show subdirectory: concurrent grabs must not collide on one staging path.
    expect(savedTo(evaluator)).toBe('/media/staging/Ghosts 2021 (2021)');
  });

  it('falls back to the library when a managed rule has no storage profile', async () => {
    // Staging would be a guess. Filing it into the library is the old behaviour,
    // which is a safe place to land — and it is logged so it can be fixed.
    const { svc, evaluator } = build({
      ...ghosts('Ghosts 2021'),
      item: { title: 'Ghosts 2021', year: 2021, libraryShowId: 'show-1' },
      libraryShow: { path: GHOSTS_DIR, title: 'Ghosts US' },
      rules: [{ id: 'rule-1', name: 'Ghosts 2021', savePath: GHOSTS_DIR, importMode: 'managed_intake' }],
      profile: null,
    });
    await svc.sweep();
    expect(savedTo(evaluator)).toBe(GHOSTS_DIR);
  });

  it('records the torrent hash and rule so Media Intake can find the download', async () => {
    /*
     * Without this the grab is invisible to intake: the trigger identifies a torrent
     * through `rss_acquisitions`, and a missing-episode grab writes no such row. A
     * file staged with nothing able to import it is worse than not staging at all.
     */
    const { svc, updates } = build({
      ...ghosts('Ghosts 2021'),
      item: { title: 'Ghosts 2021', year: 2021, libraryShowId: 'show-1' },
      libraryShow: { path: GHOSTS_DIR, title: 'Ghosts US' },
      rules: [{ id: 'rule-1', name: 'Ghosts 2021', savePath: GHOSTS_DIR, importMode: 'managed_intake' }],
      torrentHash: 'abc123',
    });
    await svc.sweep();
    const grabbed = updates.find((u: any) => u.searchStatus === 'grabbed');
    expect(grabbed).toMatchObject({ torrentHash: 'abc123' });
    expect(grabbed.intakeRuleId).toBeTruthy();
  });

  it('leaves intakeRuleId null for a legacy rule, so intake ignores the grab', async () => {
    // The backward-compatibility guarantee, at the other end of the pipe.
    const { svc, updates } = build({
      ...ghosts('Ghosts 2021'),
      item: { title: 'Ghosts 2021', year: 2021, libraryShowId: 'show-1' },
      libraryShow: { path: GHOSTS_DIR, title: 'Ghosts US' },
      rules: [{ id: 'rule-1', name: 'Ghosts 2021', savePath: GHOSTS_DIR }],
      torrentHash: 'abc123',
    });
    await svc.sweep();
    const grabbed = updates.find((u: any) => u.searchStatus === 'grabbed');
    expect(grabbed).toMatchObject({ torrentHash: 'abc123', intakeRuleId: null });
  });

  it('falls back to resolving by name when the bound show has been deleted', async () => {
    // The FK is SET NULL, so a dangling id is rare — but if the row is gone we must
    // resolve the folder rather than refuse the grab.
    const { svc, evaluator } = build({
      ...ghosts('Ghosts (US)'),
      item: { title: 'Ghosts (US)', year: 2021, libraryShowId: 'show-gone' },
      libraryShow: null,
      libraryDirs: ['Ghosts US (2021)'],
    });
    await svc.sweep();
    expect(savedTo(evaluator)).toBe(GHOSTS_DIR);
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

  it('records FAILED, not no_results, when every indexer failed', async () => {
    // The 9-1-1 case: EZTV and TPB both in Prowlarr failure backoff. The candidate
    // list is empty either way, so without run health this was stamped `no_results`
    // — "we looked and this release does not exist" — when nothing had looked at all.
    const { svc, updates, evaluator, audit } = build({
      candidates: [],
      indexerRun: {
        queried: 2,
        failed: 2,
        failures: [
          { name: 'EZTV', message: 'HTTP 429' },
          { name: 'TPB', message: 'HTTP 429' },
        ],
      },
    });

    const summary = await svc.sweep();

    expect(updates[updates.length - 1]).toMatchObject({ searchStatus: 'failed' });
    expect(summary).toMatchObject({ grabbed: 0 });
    expect(evaluator.grabSelected).not.toHaveBeenCalled();
    // The outage is auditable, with which indexers failed and why.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'media_acquisition.missing_episode.indexers_unavailable',
        result: 'failure',
        metadata: expect.objectContaining({ indexersQueried: 2 }),
      }),
    );
  });

  it('still records no_results when a surviving indexer answered with nothing', async () => {
    // A PARTIAL outage is not an outage: one indexer answered, so an empty result is
    // a real answer and must not be downgraded to `failed`.
    const { svc, updates } = build({
      candidates: [],
      indexerRun: { queried: 2, failed: 1, failures: [{ name: 'EZTV', message: 'HTTP 429' }] },
    });

    await svc.sweep();

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

describe('MissingEpisodeSearchService — query spelling', () => {
  /*
   * Indexers tokenize a query, and punctuation in the stored title does not
   * survive that. Live on synoplex, all 113 wanted episodes of "9-1-1" sat at
   * `no_results` while the show's own folder was full of `9-1-1.S08E10...`
   * releases: the title was unaskable, not the release unavailable.
   */
  it('retries a punctuated title without its punctuation', async () => {
    const { svc, evaluator, indexers } = build({
      item: { title: '9-1-1', year: null },
      wanted: { seriesTconst: null },
      rules: [{ id: 'r1', name: '9-1-1', savePath: '/downloads/TV Shows/9-1-1 (2018)' }],
      candidatesByQuery: { '9 1 1': [cand({ title: '9-1-1 S01E01 1080p x265' })] },
    });
    await svc.sweep();

    const asked = indexers.searchAllDetailed.mock.calls.map((c: any) => c[0].q);
    expect(asked).toEqual(['9-1-1', '9 1 1']);
    expect(evaluator.grabSelected).toHaveBeenCalled();
  });

  it('falls further to title + year when the bare title finds nothing', async () => {
    // "might need the show's year" — a title too generic to search on its own.
    const { svc, evaluator, indexers } = build({
      item: { title: '9-1-1', year: 2018 },
      wanted: { seriesTconst: null },
      rules: [{ id: 'r1', name: '9-1-1', savePath: '/downloads/TV Shows/9-1-1 (2018)' }],
      candidatesByQuery: { '9 1 1 2018': [cand({ title: '9-1-1 2018 S01E01 1080p x265' })] },
    });
    await svc.sweep();

    expect(indexers.searchAllDetailed.mock.calls.map((c: any) => c[0].q))
      .toEqual(['9-1-1', '9 1 1', '9 1 1 2018']);
    expect(evaluator.grabSelected).toHaveBeenCalled();
  });

  it('searches an ALIAS, not just validates against it', async () => {
    /*
     * Aliases were already handed to the selector, so one could confirm a release
     * but never go looking for it — the wrong half of the job for a title nobody
     * can spell. 9-1-1 carries the alias "911" on synoplex.
     */
    const { svc, indexers } = build({
      item: { title: '9-1-1', year: null, titleAliases: ['911'] },
      wanted: { seriesTconst: null },
      rules: [{ id: 'r1', name: '9-1-1', savePath: '/downloads/TV Shows/9-1-1 (2018)' }],
      candidatesByQuery: {},
    });
    await svc.sweep();
    expect(indexers.searchAllDetailed.mock.calls.map((c: any) => c[0].q)).toContain('911');
  });

  it('elides an apostrophe rather than splitting on it', async () => {
    // Release names ship "Greys.Anatomy", never "Grey s Anatomy".
    const { svc, indexers } = build({
      item: { title: "Grey's Anatomy", year: null },
      wanted: { seriesTconst: null },
      rules: [{ id: 'r1', name: "Grey's Anatomy", savePath: '/downloads/TV Shows/Greys' }],
      candidatesByQuery: {},
    });
    await svc.sweep();
    const asked = indexers.searchAllDetailed.mock.calls.map((c: any) => c[0].q);
    expect(asked).toContain('greys anatomy');
    expect(asked.some((q: string) => q.includes('grey s'))).toBe(false);
  });

  it('asks exactly ONCE for a show whose title already works', async () => {
    // The cost guard: widening must not multiply indexer traffic for the shows
    // that were never broken.
    const { svc, indexers } = build({
      item: { title: 'All American', year: 2018 },
      wanted: { seriesTconst: null },
      rules: [{ id: 'r1', name: 'All American', savePath: '/downloads/TV Shows/All American (2018)' }],
      candidatesByQuery: { 'All American': [cand({ title: 'All American S03E02 720p x265' })] },
    });
    await svc.sweep();
    expect(indexers.searchAllDetailed).toHaveBeenCalledTimes(1);
  });

  it('stops widening the moment every indexer is down', async () => {
    // Retrying dead indexers with a different spelling only multiplies failures,
    // and the honest state is still `failed`, never `no_results`.
    const { svc, indexers, updates } = build({
      item: { title: '9-1-1', year: 2018 },
      wanted: { seriesTconst: null },
      rules: [{ id: 'r1', name: '9-1-1', savePath: '/downloads/TV Shows/9-1-1 (2018)' }],
      indexerRun: { queried: 2, failed: 2 },
    });
    await svc.sweep();
    expect(indexers.searchAllDetailed).toHaveBeenCalledTimes(1);
    expect(updates.some((u: any) => u.searchStatus === 'failed')).toBe(true);
    expect(updates.some((u: any) => u.searchStatus === 'no_results')).toBe(false);
  });
});

describe('MissingEpisodeSearchService — a failed add is not a grab', () => {
  it('records FAILED when the engine accepted no torrent', async () => {
    /*
     * Live on synoplex, 32 episodes sat at `grabbed` against a download action
     * whose status was `failed` and whose result was null — no torrent was ever
     * added. Because the sweep selects only idle/no_results/failed, each was
     * permanently excluded from being searched again by a success it never had.
     */
    const { svc, updates } = build({
      candidates: [cand()],
      item: { title: 'All American', year: 2018 },
      wanted: { seriesTconst: null },
      rules: [{ id: 'r1', name: 'All American', savePath: '/downloads/TV Shows/All American (2018)' }],
      torrentHash: null,
    });
    await svc.sweep();

    expect(updates.some((u: any) => u.searchStatus === 'grabbed')).toBe(false);
    expect(updates.some((u: any) => u.searchStatus === 'failed')).toBe(true);
  });

  it('still records the evaluation, so the attempt is auditable', async () => {
    const { svc, updates } = build({
      candidates: [cand()],
      item: { title: 'All American', year: 2018 },
      wanted: { seriesTconst: null },
      rules: [{ id: 'r1', name: 'All American', savePath: '/downloads/TV Shows/All American (2018)' }],
      torrentHash: null,
    });
    await svc.sweep();

    const failed = updates.find((u: any) => u.searchStatus === 'failed');
    expect(failed.grabbedEvaluationId).toBe('ev1');
  });
});

describe('MissingEpisodeSearchService — degraded indexers', () => {
  /*
   * Widening the query is a bet that the release exists under another spelling.
   * An empty answer from a DEGRADED search is no evidence either way — it is an
   * unanswered question — and the usual reason an indexer fails here is HTTP 429.
   * Asking twice more is exactly wrong when the service is already refusing us.
   *
   * Observed live on synoplex: EZTV and TPB both throttled to 429 while ShowRSS
   * answered emptily, so every episode looked like a clean miss and every miss
   * triggered the full widening — tripling traffic into the service refusing it.
   */
  const partialRun = { queried: 3, failed: 2, failures: [{ name: 'EZTV', message: 'HTTP 429' }] };

  it('does NOT widen when some indexers failed and nothing was found', async () => {
    const { svc, indexers } = build({
      item: { title: '9-1-1', year: 2018 },
      wanted: { seriesTconst: null },
      rules: [{ id: 'r1', name: '9-1-1', savePath: '/downloads/TV Shows/9-1-1 (2018)' }],
      indexerRun: partialRun,
    });
    await svc.sweep();
    expect(indexers.searchAllDetailed).toHaveBeenCalledTimes(1);
  });

  it('leaves the recorded status alone — a partial miss is still no_results', async () => {
    /*
     * Deliberately NOT changed. An earlier decision, with its own test, holds that
     * one indexer answering emptily is a real if partial answer and must not be
     * downgraded to `failed`. Both states retry on the same backoff, so the
     * difference is what the operator reads, not what the sweep does — not worth
     * reversing someone's considered call as a side effect of a traffic fix.
     */
    const { svc, updates } = build({
      item: { title: '9-1-1', year: 2018 },
      wanted: { seriesTconst: null },
      rules: [{ id: 'r1', name: '9-1-1', savePath: '/downloads/TV Shows/9-1-1 (2018)' }],
      indexerRun: partialRun,
    });
    await svc.sweep();
    expect(updates.some((u: any) => u.searchStatus === 'no_results')).toBe(true);
  });

  it('STILL widens when every indexer answered and simply found nothing', async () => {
    // The fix must not disable the feature: a clean, complete miss is real
    // evidence that this spelling is wrong, and that is what widening is for.
    const { svc, indexers } = build({
      item: { title: '9-1-1', year: 2018 },
      wanted: { seriesTconst: null },
      rules: [{ id: 'r1', name: '9-1-1', savePath: '/downloads/TV Shows/9-1-1 (2018)' }],
      indexerRun: { queried: 3, failed: 0, failures: [] },
    });
    await svc.sweep();
    expect(indexers.searchAllDetailed).toHaveBeenCalledTimes(3);
  });

  it('a partial run that DID find something is used normally', async () => {
    // One indexer down does not invalidate a release another one returned.
    const { svc, evaluator } = build({
      item: { title: '9-1-1', year: 2018 },
      wanted: { seriesTconst: null },
      rules: [{ id: 'r1', name: '9-1-1', savePath: '/downloads/TV Shows/9-1-1 (2018)' }],
      candidates: [cand({ title: '9-1-1 S01E01 1080p x265' })],
      indexerRun: partialRun,
    });
    await svc.sweep();
    expect(evaluator.grabSelected).toHaveBeenCalled();
  });
});
