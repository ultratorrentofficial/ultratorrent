/**
 * A title containing a slash must not create directories.
 *
 * `renderTemplate` interpolates token values into one string and then splits it
 * on `/` to get path segments, so a separator inside a VALUE was
 * indistinguishable from one the template author wrote. Real films carry them —
 * `Face/Off`, `Mother/Android`, `Frost/Nixon` — and each rendered four segments
 * where the template asked for two, burying the file several directories deep.
 *
 * It compounds, which is what made it visible: the next run re-derives the title
 * from the already-nested path and buries it one level further. Found on the
 * live library as
 *
 *   HD Movies/Face Off (1997)/Off (1997)/Face/Off (1997)/Face/Off (1997)/
 *     Face/Off (1997)/Face/Off (1997) - 1080p.mp4
 *
 * — re-nested four times. `sanitizeSegment` has always listed `/` as illegal and
 * turns `Face/Off` into `Face Off`; it simply never ran on the whole value,
 * because the split came first.
 */
import { renderTemplate, sanitizeSegment, buildRenamePlan } from './media-renamer';

const MOVIE_TPL = '{Movie Title} ({year})/{Movie Title} ({year}) - {Resolution}.{ext}';
const TV_TPL =
  '{Series Title}{year? ({year})}/Season {season}/{Series Title} - S{season:00}E{episode:00}.{ext}';

describe('a token value cannot create path segments', () => {
  it('renders a slashed film title as ONE folder and ONE file', () => {
    const rel = renderTemplate(MOVIE_TPL, {
      'Movie Title': 'Face/Off', year: 1997, Resolution: '1080p', ext: 'mp4',
    });
    expect(rel.split('/')).toHaveLength(2);
    expect(rel).toBe('Face Off (1997)/Face Off (1997) - 1080p.mp4');
  });

  it('strips a backslash as well, though that one was never the bug', () => {
    // Honest about which half this covers: `\` never split anything (the split is
    // on `/` only), so `sanitizeSegment` already caught it and this passes with or
    // without the fix. Kept as a guard that neutralising `/` did not somehow let a
    // `\` through, not as evidence the fix works.
    const rel = renderTemplate(MOVIE_TPL, {
      'Movie Title': 'Face\\Off', year: 1997, Resolution: '1080p', ext: 'mp4',
    });
    expect(rel.split('/')).toHaveLength(2);
    expect(rel).not.toMatch(/\\/);
  });

  it('agrees with what sanitizeSegment would have produced', () => {
    // The rule already existed; it was unreachable. This pins them together so a
    // future change to one cannot silently diverge from the other.
    expect(sanitizeSegment('Face/Off')).toBe('Face Off');
    const rel = renderTemplate('{Movie Title}.{ext}', { 'Movie Title': 'Face/Off', ext: 'mp4' });
    expect(rel).toBe('Face Off.mp4');
  });

  it('does not nest a slashed SERIES title either', () => {
    const rel = renderTemplate(TV_TPL, {
      'Series Title': 'Mother/Android', year: 2021, season: 1, episode: 2, ext: 'mkv',
    });
    // Show folder + Season folder + file = 3. Not 5.
    expect(rel.split('/')).toHaveLength(3);
    expect(rel.startsWith('Mother Android (2021)/')).toBe(true);
  });

  it('STILL lets the template create the folders it asks for', () => {
    // The half that must not regress: the template's own separators are structure.
    const rel = renderTemplate(MOVIE_TPL, {
      'Movie Title': 'Mulan', year: 2020, Resolution: '1080p', ext: 'mp4',
    });
    expect(rel).toBe('Mulan (2020)/Mulan (2020) - 1080p.mp4');
  });

  it('does not compound across runs — re-planning a placed file is stable', () => {
    /*
     * The compounding is the real damage. Rendering twice from the same title
     * must give the same depth; before the fix each pass added segments.
     */
    const once = renderTemplate(MOVIE_TPL, {
      'Movie Title': 'Face/Off', year: 1997, Resolution: '1080p', ext: 'mp4',
    });
    const twice = renderTemplate(MOVIE_TPL, {
      // The title as it would be re-derived from the already-rendered folder.
      'Movie Title': once.split('/')[0].replace(/ \(\d{4}\)$/, ''),
      year: 1997, Resolution: '1080p', ext: 'mp4',
    });
    expect(twice).toBe(once);
  });

  it('plans a slashed-title file to a two-segment destination end to end', () => {
    // Through the planner, not just the renderer — the destination is what lands.
    const plan = buildRenamePlan({
      sourceName: 'Face.Off.1997.1080p',
      files: [{ path: 'Face.Off.1997.1080p.mkv', size: 2_000_000_000 }],
      preset: 'plex',
      mode: 'rename_move',
      libraryPath: '/media/Movies',
      template: MOVIE_TPL,
      meta: { movieTitle: 'Face/Off', year: 1997 },
    });
    const item = plan.items.find((i) => i.source.endsWith('.mkv'))!;
    expect(item.destination).toBe('/media/Movies/Face Off (1997)/Face Off (1997) - 1080p.mkv');
  });
});
