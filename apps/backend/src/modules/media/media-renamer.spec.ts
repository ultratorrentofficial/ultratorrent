import {
  buildRenamePlan,
  classifyFile,
  isSeasonContainer,
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
});

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
    expect(v?.destination).toBe('/media/TV/The Example Show/Season 02/The Example Show - S02E05 - The Reckoning.mkv');
    expect(v?.action).toBe('move');
  });
  it('matches the subtitle to the video and keeps the language tag', () => {
    const s = plan.items.find((i) => i.isSubtitle);
    expect(s?.destination).toBe('/media/TV/The Example Show/Season 02/The Example Show - S02E05 - The Reckoning.en.srt');
  });
  it('skips the sample file', () => {
    const sample = plan.items.find((i) => i.isSample);
    expect(sample?.skipped).toBe(true);
    expect(sample?.action).toBe('skip');
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
    expect(plan.items[0].destination).toContain('/m/Show/Season 01/');
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
    // just organised into Season 08 and renamed.
    expect(primary(plan).destination).toBe(
      '/downloads/TV/TV_Shows/The Rookie (2018)/Season 08/The Rookie - S08E16 - Out of Time.mkv',
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
      '/downloads/TV/TV_Shows/The Rookie (2018)/Season 08/The Rookie - S08E16 - Out of Time.mkv',
    );
  });

  it('rename_move re-roots to the full templated library path', () => {
    const plan = buildRenamePlan(ctx({
      ...common,
      mode: 'rename_move',
      files: [{ path: '/downloads/TV/TV_Shows/The Rookie (2018)/The.Rookie.S08E16.mkv', size: 2e9 }],
    }));
    expect(primary(plan).destination).toBe(
      '/downloads/TV/TV_Shows/The Rookie/Season 08/The Rookie - S08E16 - Out of Time.mkv',
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
      '/downloads/TV/TV_Shows/The Rookie/Season 08/The Rookie - S08E16 - Out of Time.mkv',
    );
  });
});
