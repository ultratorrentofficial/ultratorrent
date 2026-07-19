import {
  buildRenamePlan,
  classifyFile,
  globToRegExp,
  isRenderedPathSafe,
  isSeasonContainer,
  matchesAnyGlob,
  normalizeLang,
  renderTemplate,
  sanitizeSegment,
  showFolderRoot,
  RenameContext,
} from './media-renamer';

const ctx = (over: Partial<RenameContext>): RenameContext => ({
  sourceName: over.sourceName ?? '',
  files: over.files ?? [],
  preset: over.preset ?? 'plex',
  mode: over.mode ?? 'rename_move',
  libraryPath: over.libraryPath ?? '/media',
  template: over.template,
  meta: over.meta,
  sampleMaxBytes: over.sampleMaxBytes,
  cleanup: over.cleanup,
});

const BIG = 2_000_000_000; // 2 GB — never a "sample"

describe('sanitizeSegment', () => {
  it('strips illegal characters and trailing dots/spaces', () => {
    expect(sanitizeSegment('A: B/C*?"<>|  ')).toBe('A B C');
    expect(sanitizeSegment('Title.')).toBe('Title');
  });
});

describe('renderTemplate', () => {
  it('renders tokens with zero-padding', () => {
    expect(renderTemplate('S{season:00}E{episode:00}', { season: 2, episode: 5 })).toBe('S02E05');
  });
  it('emits optional segment only when token present', () => {
    const t = 'E{episode:00}{episodeEnd? - E{episodeEnd:00}}';
    expect(renderTemplate(t, { episode: 5, episodeEnd: 6 })).toBe('E05 - E06');
    expect(renderTemplate(t, { episode: 5 })).toBe('E05');
  });
});

describe('classifyFile', () => {
  it('flags a small sample video', () => {
    const c = classifyFile('Sample/sample.mkv', 'tv', 50 * 1024 * 1024, 10 * 1024 * 1024);
    expect(c.isSample).toBe(true);
  });
  it('detects subtitles and audiobooks', () => {
    expect(classifyFile('x.en.srt', 'tv', 0, 1).isSubtitle).toBe(true);
    expect(classifyFile('book.m4b', 'general', 0, 1).kind).toBe('audiobook');
  });
});

describe('buildRenamePlan — TV', () => {
  const plan = buildRenamePlan(ctx({
    sourceName: 'The.Example.Show.S02E05.1080p.WEB-DL.x265-GROUP',
    files: [
      { path: 'The.Example.Show.S02E05.1080p.WEB-DL.x265-GROUP.mkv', size: 2_000_000_000 },
      { path: 'The.Example.Show.S02E05.1080p.WEB-DL.x265-GROUP.en.srt', size: 50_000 },
      { path: 'Sample/sample.mkv', size: 8_000_000 },
    ],
    preset: 'plex',
    mode: 'rename_move',
    libraryPath: '/media/TV',
    meta: { episodeTitle: 'The Reckoning' },
  }));

  it('renames the episode into a Plex path', () => {
    const v = plan.items.find((i) => i.source.endsWith('GROUP.mkv'));
    expect(v?.destination).toBe('/media/TV/The Example Show/Season 2/The Example Show - S02E05 - The Reckoning.mkv');
    expect(v?.action).toBe('move');
  });
  it('matches the subtitle to the video and keeps the language tag', () => {
    const s = plan.items.find((i) => i.isSubtitle);
    expect(s?.destination).toBe('/media/TV/The Example Show/Season 2/The Example Show - S02E05 - The Reckoning.en.srt');
  });
  it('skips the sample file', () => {
    const sample = plan.items.find((i) => i.isSample);
    expect(sample?.skipped).toBe(true);
    expect(sample?.action).toBe('skip');
  });
});

describe('buildRenamePlan — identity comes from each file, not the batch', () => {
  // A library preview passes the SHOW FOLDER as sourceName. It carries no SxxEyy, so
  // parsing only it left season/episode undefined for every file: each one rendered to
  // the same `FBI/Season/FBI - SE.mkv`, and the plan came back as a chain of duplicate
  // -destination warnings with 89 episodes aimed at one path. Observed live on
  // "FBI (2018)". Each file's own basename is where its episode number actually is.
  const plan = buildRenamePlan(ctx({
    sourceName: 'FBI (2018)',
    files: [
      { path: '/downloads/TV/TV_Shows/FBI (2018)/FBI.S08E22.Defector.1080p.HEVC.x265-MeGusta.mkv', size: BIG },
      { path: '/downloads/TV/TV_Shows/FBI (2018)/Season 6/FBI - S06E01 - All the Rage.mkv', size: BIG },
      { path: '/downloads/TV/TV_Shows/FBI (2018)/FBI.S05E16.1080p.HEVC.x265-MeGusta.mkv', size: BIG },
    ],
    preset: 'plex',
    mode: 'rename_move',
    libraryPath: '/media/TV',
  }));

  it('gives each episode its own season and episode number', () => {
    const dests = plan.items.filter((i) => !i.skipped).map((i) => i.destination);
    expect(dests).toContain('/media/TV/FBI/Season 8/FBI - S08E22.mkv');
    expect(dests).toContain('/media/TV/FBI/Season 6/FBI - S06E01.mkv');
    expect(dests).toContain('/media/TV/FBI/Season 5/FBI - S05E16.mkv');
  });

  it('reports no duplicate destinations', () => {
    expect(plan.warnings.filter((w) => w.includes('Duplicate destination'))).toEqual([]);
  });

  it('still falls back to the release name when the file name says nothing', () => {
    // Single-file torrent: the episode lives in the release name, the inner file is
    // generically named. The batch parse has to keep winning here.
    const single = buildRenamePlan(ctx({
      sourceName: 'The.Example.Show.S02E05.1080p.WEB-DL.x265-GROUP',
      files: [{ path: 'video.mkv', size: BIG }],
      preset: 'plex',
      mode: 'rename_move',
      libraryPath: '/media/TV',
    }));
    expect(single.items[0]?.destination).toBe('/media/TV/The Example Show/Season 2/The Example Show - S02E05.mkv');
  });
});

describe('buildRenamePlan — metadata sidecars follow their video', () => {
  // A .nfo / -thumb.jpg is named after its video. Renaming the video and leaving the
  // sidecar behind orphans it — the .nfo keeps the old basename and describes nothing,
  // and the renamed episode has no metadata beside it. tinyMediaManager (which writes
  // these) moves them WITH the video, so dropping them quietly undid its work on a
  // library both tools share.
  const plan = buildRenamePlan(ctx({
    sourceName: 'The Librarians - S01E03 - And the Horns of a Dilemma',
    files: [
      { path: 'The Librarians - S01E03 - And the Horns of a Dilemma.mp4', size: BIG },
      { path: 'The Librarians - S01E03 - And the Horns of a Dilemma.nfo', size: 4_000 },
      { path: 'The Librarians - S01E03 - And the Horns of a Dilemma-thumb.jpg', size: 90_000 },
      { path: 'The Librarians - S01E03 - And the Horns of a Dilemma-mediainfo.xml', size: 8_000 },
      // Show-level artwork: belongs to the FOLDER, not to this episode.
      { path: 'poster.jpg', size: 200_000 },
      { path: 'tvshow.nfo', size: 6_000 },
      { path: 'season01-poster.jpg', size: 150_000 },
    ],
    preset: 'plex',
    mode: 'rename_move',
    libraryPath: '/media/TV',
    meta: { episodeTitle: 'And the Horns of a Dilemma' },
  }));

  const dest = (suffix: string) =>
    plan.items.find((i) => i.source.endsWith(suffix))?.destination;

  it('carries the .nfo, the thumb and the mediainfo cache to the new basename', () => {
    const video = dest('Dilemma.mp4');
    expect(video).toBe(
      '/media/TV/The Librarians/Season 1/The Librarians - S01E03 - And the Horns of a Dilemma.mp4',
    );
    const base = video!.slice(0, -'.mp4'.length);
    expect(dest('Dilemma.nfo')).toBe(`${base}.nfo`);
    expect(dest('Dilemma-thumb.jpg')).toBe(`${base}-thumb.jpg`);
    expect(dest('Dilemma-mediainfo.xml')).toBe(`${base}-mediainfo.xml`);
  });

  it('leaves show-level artwork exactly where it is', () => {
    for (const f of ['poster.jpg', 'tvshow.nfo', 'season01-poster.jpg']) {
      const item = plan.items.find((i) => i.source === f);
      expect(item?.skipped).toBe(true);
      expect(item?.destination).toBeNull();
    }
  });

  it('carries the sidecars of a two-part episode held in one file', () => {
    // The real TMM-authored two-parter from the library, sidecars and all.
    const p = buildRenamePlan(ctx({
      sourceName: 'The Librarians - S01E01 S01E02 - And the Crown of King Arthur',
      files: [
        { path: 'The Librarians - S01E01 S01E02 - And the Crown of King Arthur.mp4', size: BIG },
        { path: 'The Librarians - S01E01 S01E02 - And the Crown of King Arthur.nfo', size: 4_000 },
        { path: 'The Librarians - S01E01 S01E02 - And the Crown of King Arthur-thumb.jpg', size: 90_000 },
      ],
      preset: 'plex',
      mode: 'rename_in_place',
      libraryPath: '/media/TV',
    }));
    const video = p.items.find((i) => i.source.endsWith('.mp4'))!;
    expect(video.destination).not.toBeNull();
    const base = video.destination!.replace(/\.mp4$/, '');
    expect(p.items.find((i) => i.source.endsWith('.nfo'))?.destination).toBe(`${base}.nfo`);
    expect(p.items.find((i) => i.source.endsWith('-thumb.jpg'))?.destination).toBe(`${base}-thumb.jpg`);
  });

  it('does not mistake a different episode for a sidecar of a shorter-named one', () => {
    // "Show - S01E2" is a prefix of "Show - S01E20" as a STRING. It is not a sidecar.
    const p = buildRenamePlan(ctx({
      sourceName: 'Show',
      files: [
        { path: 'Show - S01E2.mkv', size: BIG },
        { path: 'Show - S01E20.nfo', size: 4_000 },
      ],
      preset: 'plex',
      mode: 'rename_in_place',
      libraryPath: '/media/TV',
    }));
    const nfo = p.items.find((i) => i.source.endsWith('S01E20.nfo'));
    expect(nfo?.skipped).toBe(true); // no video of that name → left alone, not attached
  });
});

describe('buildRenamePlan — movie', () => {
  it('renames a movie with year + resolution', () => {
    const plan = buildRenamePlan(ctx({
      sourceName: 'Example.Movie.2026.2160p.UHD.BluRay.x265-GROUP',
      files: [{ path: 'Example.Movie.2026.2160p.UHD.BluRay.x265-GROUP.mkv', size: 9_000_000_000 }],
      libraryPath: '/media/Movies',
    }));
    expect(plan.kind).toBe('movie');
    expect(plan.items[0].destination).toBe('/media/Movies/Example Movie (2026)/Example Movie (2026) - 2160p.mkv');
  });
});

describe('buildRenamePlan — edge cases', () => {
  it('handles multi-episode files', () => {
    const plan = buildRenamePlan(ctx({
      sourceName: 'Show.S01E01E02.1080p.WEB-DL-G',
      files: [{ path: 'Show.S01E01E02.1080p.WEB-DL-G.mkv', size: 2e9 }],
      libraryPath: '/m', meta: { episodeTitle: 'Pilot' },
    }));
    expect(plan.items[0].destination).toContain('S01E01 - E02');
  });

  it('routes specials (season 0) into a Specials folder', () => {
    const plan = buildRenamePlan(ctx({
      sourceName: 'Show.S00E01.1080p.WEB-DL-G',
      files: [{ path: 'Show.S00E01.1080p.WEB-DL-G.mkv', size: 2e9 }],
      libraryPath: '/m', meta: { episodeTitle: 'Special' },
    }));
    expect(plan.items[0].destination).toContain('/Specials/');
  });

  it('honors hardlink mode', () => {
    const plan = buildRenamePlan(ctx({
      sourceName: 'Show.S01E01.1080p-G',
      files: [{ path: 'Show.S01E01.1080p-G.mkv', size: 2e9 }],
      mode: 'hardlink', libraryPath: '/m',
    }));
    expect(plan.items[0].action).toBe('hardlink');
  });

  it('warns on duplicate destinations', () => {
    const plan = buildRenamePlan(ctx({
      sourceName: 'Show.S01E01.1080p-G',
      files: [
        { path: 'a/Show.S01E01.1080p-G.mkv', size: 2e9 },
        { path: 'b/Show.S01E01.1080p-G.mkv', size: 2e9 },
      ],
      libraryPath: '/m',
    }));
    expect(plan.warnings.some((w) => /Duplicate destination/.test(w))).toBe(true);
  });

  it('preview mode produces a plan without execution-only actions', () => {
    const plan = buildRenamePlan(ctx({
      sourceName: 'Show.S01E01.720p-G',
      files: [{ path: 'Show.S01E01.720p-G.mkv', size: 2e9 }],
      mode: 'preview', libraryPath: '/m',
    }));
    expect(plan.mode).toBe('preview');
    expect(plan.items[0].destination).toContain('/m/Show/Season 1/');
  });

  it('never renames a primary video onto a corrupt-template path (the "{" clobber)', () => {
    const plan = buildRenamePlan(ctx({
      sourceName: 'Show.S01E01.1080p-G',
      files: [{ path: 'Show.S01E01.1080p-G.mkv', size: 2e9 }],
      libraryPath: '/m',
      template: '{', // corrupted library template
    }));
    const primary = plan.items.find((i) => i.source.endsWith('.mkv'));
    expect(primary?.action).toBe('skip');
    expect(primary?.destination).toBeNull();
    expect(primary?.reason).toMatch(/invalid naming template/i);
    expect(plan.warnings.some((w) => /unsafe destination/i.test(w))).toBe(true);
  });
});

describe('isRenderedPathSafe', () => {
  it('accepts a normal rendered path', () => {
    expect(isRenderedPathSafe('Show/Season 1/Show - S01E01.mkv', '.mkv')).toBe(true);
  });
  it('rejects a bare "{" (unclosed token survives sanitization)', () => {
    expect(isRenderedPathSafe('{', '.mkv')).toBe(false);
  });
  it('rejects unresolved braces from a truncated template', () => {
    expect(isRenderedPathSafe('Show/{', '.mkv')).toBe(false);
  });
  it('rejects an empty render and an extension-less basename', () => {
    expect(isRenderedPathSafe('', '.mkv')).toBe(false);
    expect(isRenderedPathSafe('Show/Season 1/Show - S01E01', '.mkv')).toBe(false);
  });
});

describe('buildRenamePlan — identity name resolves a bare filename', () => {
  // A file whose name carries no title (e.g. `S01E01.mkv`) would fall back to an
  // "Unknown" series folder. The processing pipeline prepends the already-
  // identified title to the name (via RenameRequest.sourceName) so the plan
  // resolves the real series + a padded, unpadded-folder Plex path.
  it('falls back to Unknown when the name has no title', () => {
    const plan = buildRenamePlan(ctx({
      sourceName: 'S01E01.1080p.x265-GRP.mkv',
      files: [{ path: 'S01E01.1080p.x265-GRP.mkv', size: 2e9 }],
      libraryPath: '/tv',
    }));
    expect(plan.items[0].destination).toContain('/tv/Unknown/Season 1/');
  });

  it('resolves the series once the identified title is fed in', () => {
    const plan = buildRenamePlan(ctx({
      sourceName: 'Breaking Bad S01E01.1080p.x265-GRP.mkv',
      files: [{ path: 'S01E01.1080p.x265-GRP.mkv', size: 2e9 }],
      libraryPath: '/tv',
      meta: { episodeTitle: 'Pilot' },
    }));
    expect(plan.items[0].destination).toBe(
      '/tv/Breaking Bad/Season 1/Breaking Bad - S01E01 - Pilot.mkv',
    );
  });
});

describe('isSeasonContainer / showFolderRoot', () => {
  it('recognises season/specials containers', () => {
    expect(isSeasonContainer('Season 8')).toBe(true);
    expect(isSeasonContainer('Season 08')).toBe(true);
    expect(isSeasonContainer('Specials')).toBe(true);
    expect(isSeasonContainer('The Rookie (2018)')).toBe(false);
  });
  it('climbs past a season folder to the show root', () => {
    expect(showFolderRoot('/tv/The Rookie (2018)/Season 8/ep.mkv')).toBe('/tv/The Rookie (2018)');
    expect(showFolderRoot('/tv/The Rookie (2018)/ep.mkv')).toBe('/tv/The Rookie (2018)');
  });
});

describe('buildRenamePlan — rename_in_place keeps the show folder', () => {
  const common = {
    sourceName: 'The.Rookie.S08E16.Out.of.Time.1080p.x265-MeGusta',
    libraryPath: '/downloads/TV/TV_Shows',
    meta: { episodeTitle: 'Out of Time' } as never,
  };
  const primary = (plan: ReturnType<typeof buildRenamePlan>) =>
    plan.items.find((i) => !i.skipped && !i.isSubtitle)!;

  it('re-homes into the season subdir WITHIN the existing show folder (no year re-derivation)', () => {
    // File dropped in the show-folder root by the RSS rule.
    const plan = buildRenamePlan(ctx({
      ...common,
      mode: 'rename_in_place',
      files: [{ path: '/downloads/TV/TV_Shows/The Rookie (2018)/The.Rookie.S08E16.Out.of.Time.1080p.x265-MeGusta.mkv', size: 2e9 }],
    }));
    // Stays in "The Rookie (2018)" (never forks to a year-less "The Rookie"),
    // just organised into Season 8 and renamed.
    expect(primary(plan).destination).toBe(
      '/downloads/TV/TV_Shows/The Rookie (2018)/Season 8/The Rookie - S08E16 - Out of Time.mkv',
    );
    expect(primary(plan).action).toBe('rename');
  });

  it('climbs past an existing season folder to keep the show folder', () => {
    const plan = buildRenamePlan(ctx({
      ...common,
      mode: 'rename_in_place',
      files: [{ path: '/downloads/TV/TV_Shows/The Rookie (2018)/Season 8/The Rookie - S08E16.mkv', size: 2e9 }],
    }));
    expect(primary(plan).destination).toBe(
      '/downloads/TV/TV_Shows/The Rookie (2018)/Season 8/The Rookie - S08E16 - Out of Time.mkv',
    );
  });

  it('rename_move re-roots to the full templated library path', () => {
    const plan = buildRenamePlan(ctx({
      ...common,
      mode: 'rename_move',
      files: [{ path: '/downloads/TV/TV_Shows/The Rookie (2018)/The.Rookie.S08E16.mkv', size: 2e9 }],
    }));
    expect(primary(plan).destination).toBe(
      '/downloads/TV/TV_Shows/The Rookie/Season 8/The Rookie - S08E16 - Out of Time.mkv',
    );
    expect(primary(plan).action).toBe('move');
  });

  it('rename_in_place with a base-relative source still re-roots (torrent post-download flow)', () => {
    const plan = buildRenamePlan(ctx({
      ...common,
      mode: 'rename_in_place',
      files: [{ path: 'The.Rookie.S08E16.Out.of.Time.1080p.x265-MeGusta.mkv', size: 2e9 }],
    }));
    expect(primary(plan).destination).toBe(
      '/downloads/TV/TV_Shows/The Rookie/Season 8/The Rookie - S08E16 - Out of Time.mkv',
    );
  });
});

describe('cleanup helpers', () => {
  it('globToRegExp matches literally except for wildcards', () => {
    expect(globToRegExp('YTS*.txt').test('YTS.MX.txt')).toBe(true);
    expect(globToRegExp('YTS*.txt').test('readme.txt')).toBe(false);
    expect(globToRegExp('*.jpg').test('poster.jpg')).toBe(true);
    expect(globToRegExp('sample?.mkv').test('sample1.mkv')).toBe(true);
    expect(globToRegExp('sample?.mkv').test('sample.mkv')).toBe(false);
    // A dot in the pattern is literal, not "any char".
    expect(globToRegExp('a.txt').test('axtxt')).toBe(false);
  });

  it('matchesAnyGlob is case-insensitive and swallows bad patterns', () => {
    expect(matchesAnyGlob('RARBG.TXT', ['rarbg.txt'])).toBe(true);
    expect(matchesAnyGlob('x.txt', ['[', '*.txt'])).toBe(true); // '[' never throws
    expect(matchesAnyGlob('x.mkv', ['*.txt'])).toBe(false);
  });

  it('normalizeLang maps 639-2 to 639-1 when known', () => {
    expect(normalizeLang('eng')).toBe('en');
    expect(normalizeLang('SPA')).toBe('es');
    expect(normalizeLang('en')).toBe('en');
    expect(normalizeLang('xx')).toBe('xx');
  });
});

describe('buildRenamePlan — cleanup', () => {
  const rules = (over = {}) => ({
    enabled: true,
    deleteGlobs: [] as string[],
    subtitleKeepLanguages: [] as string[],
    pruneEmptyDirs: false,
    removeLeftoverTorrent: false,
    ...over,
  });
  const byAction = (plan: ReturnType<typeof buildRenamePlan>, action: string) =>
    plan.items.filter((i) => i.action === action).map((i) => i.source);

  it('deletes files matching cleanup globs but still moves the video', () => {
    const plan = buildRenamePlan(
      ctx({
        sourceName: 'The Movie 2020 1080p',
        mode: 'rename_move',
        files: [
          { path: '/dl/The Movie 2020 1080p.mkv', size: BIG },
          { path: '/dl/YTS.MX.txt', size: 500 },
          { path: '/dl/poster.jpg', size: 9000 },
        ],
        cleanup: rules({ deleteGlobs: ['YTS*.txt', '*.jpg'] }),
      }),
    );
    expect(byAction(plan, 'delete').sort()).toEqual(['/dl/YTS.MX.txt', '/dl/poster.jpg'].sort());
    const video = plan.items.find((i) => i.source.endsWith('.mkv'))!;
    expect(video.action).not.toBe('delete');
    expect(video.destination).toContain('The Movie (2020)');
  });

  it('deletes subtitles whose language is not in the keep-list, keeps kept + untagged', () => {
    const plan = buildRenamePlan(
      ctx({
        sourceName: 'The Movie 2020 1080p',
        mode: 'rename_move',
        files: [
          { path: '/dl/The Movie 2020 1080p.mkv', size: BIG },
          { path: '/dl/The Movie 2020 1080p.en.srt', size: 100 },
          { path: '/dl/The Movie 2020 1080p.spa.srt', size: 100 }, // 639-2 alias of es
          { path: '/dl/The Movie 2020 1080p.fr.srt', size: 100 },
          { path: '/dl/The Movie 2020 1080p.srt', size: 100 }, // untagged
        ],
        cleanup: rules({ subtitleKeepLanguages: ['en', 'es'] }),
      }),
    );
    expect(byAction(plan, 'delete')).toEqual(['/dl/The Movie 2020 1080p.fr.srt']);
    // en, spa(→es) and the untagged sub are NOT deleted.
    const deleted = new Set(byAction(plan, 'delete'));
    expect(deleted.has('/dl/The Movie 2020 1080p.en.srt')).toBe(false);
    expect(deleted.has('/dl/The Movie 2020 1080p.spa.srt')).toBe(false);
    expect(deleted.has('/dl/The Movie 2020 1080p.srt')).toBe(false);
  });

  it('never deletes a primary video even if a glob would match it', () => {
    const plan = buildRenamePlan(
      ctx({
        sourceName: 'The Movie 2020 1080p',
        mode: 'rename_move',
        files: [{ path: '/dl/The Movie 2020 1080p.mkv', size: BIG }],
        cleanup: rules({ deleteGlobs: ['*.mkv'] }),
      }),
    );
    expect(byAction(plan, 'delete')).toEqual([]);
    expect(plan.items[0].action).not.toBe('delete');
  });

  it('is inert for copy/hardlink/symlink modes (source is the seeding copy)', () => {
    for (const mode of ['copy', 'hardlink', 'symlink'] as const) {
      const plan = buildRenamePlan(
        ctx({
          sourceName: 'The Movie 2020 1080p',
          mode,
          files: [
            { path: '/dl/The Movie 2020 1080p.mkv', size: BIG },
            { path: '/dl/YTS.MX.txt', size: 500 },
          ],
          cleanup: rules({ deleteGlobs: ['YTS*.txt'] }),
        }),
      );
      expect(byAction(plan, 'delete')).toEqual([]);
    }
  });

  it('deletes nothing when cleanup is disabled', () => {
    const plan = buildRenamePlan(
      ctx({
        sourceName: 'The Movie 2020 1080p',
        mode: 'rename_move',
        files: [
          { path: '/dl/The Movie 2020 1080p.mkv', size: BIG },
          { path: '/dl/YTS.MX.txt', size: 500 },
        ],
        cleanup: rules({ enabled: false, deleteGlobs: ['YTS*.txt'] }),
      }),
    );
    expect(byAction(plan, 'delete')).toEqual([]);
  });
});
