import { subtitleLangTag, buildRenamePlan } from './media-renamer';

/**
 * A release's `Subs/` folder is named by language and nothing else:
 * `English.srt`, `ara.srt`, `fre.srt`. The tag matcher required a dot before
 * the code, so all 32 read as untagged, all 32 were named after the video with
 * no tag, and all 32 targeted one destination — colliding in turn.
 *
 * The collisions then dragged the film itself to `[dup31]` (fixed separately in
 * `setAside`), which is how a folder ended up looking like it held a duplicate
 * of a film that only existed once.
 */
describe('subtitleLangTag', () => {
  it('reads the tag a dotted name carries, as before', () => {
    expect(subtitleLangTag('Movie (2026) - 1080p.eng')).toBe('eng');
    expect(subtitleLangTag('Movie (2026) - 1080p.spa')).toBe('spa');
    expect(subtitleLangTag('Simplified.chi')).toBe('chi');
    expect(subtitleLangTag('SDH.eng.HI')).toBe('hi');
  });

  it('reads a bare language code as the language', () => {
    expect(subtitleLangTag('ara')).toBe('ara');
    expect(subtitleLangTag('fre')).toBe('fre');
    expect(subtitleLangTag('ger')).toBe('ger');
  });

  it('reads a spelled-out language name', () => {
    expect(subtitleLangTag('English')).toBe('eng');
    expect(subtitleLangTag('Portuguese')).toBe('por');
    expect(subtitleLangTag('Vietnamese')).toBe('vie');
  });

  it('strips a leading index, which is how packs number repeats', () => {
    expect(subtitleLangTag('2_English')).toBe('eng');
    expect(subtitleLangTag('3_English')).toBe('eng');
  });

  it('refuses to guess at anything that is not a language', () => {
    // Guessing here would put a file the operator never classified in front of
    // a language keep-list, and untagged subtitles are deliberately KEPT.
    expect(subtitleLangTag('abc')).toBeNull();
    expect(subtitleLangTag('Movie (2026) - 1080p')).toBeNull();
    expect(subtitleLangTag('')).toBeNull();
    expect(subtitleLangTag('readme')).toBeNull();
  });
});

describe('a language-named Subs folder', () => {
  it('gives every subtitle its own destination instead of one shared name', () => {
    const langs = ['English', 'ara', 'cze', 'dan', 'dut', 'fre', 'ger', 'gre', 'heb', 'ita'];
    const plan = buildRenamePlan({
      sourceName: 'Some Film (2026) [1080p] [WEBRip] [YTS.GG]',
      libraryPath: '/library',
      preset: 'plex',
      mode: 'hardlink',
      files: [
        { path: 'Some.Film.2026.1080p.mp4', size: 2_000_000_000 },
        ...langs.map((l) => ({ path: `Subs/${l}.srt`, size: 80_000 })),
      ],
    });

    const subs = plan.items.filter((i) => i.isSubtitle && i.destination);
    expect(subs).toHaveLength(langs.length);

    // The property that was broken: every destination distinct.
    const destinations = new Set(subs.map((i) => i.destination));
    expect(destinations.size).toBe(langs.length);
    expect(subs.some((i) => i.destination!.endsWith('.ara.srt'))).toBe(true);
    expect(subs.some((i) => i.destination!.endsWith('.eng.srt'))).toBe(true);
  });
});
