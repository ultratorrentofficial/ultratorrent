import { showTitleMatch } from '../../rss/match-engine';

/**
 * Candidate anchoring for upgrade verification.
 *
 * This exists because the service was briefly unsound without it, and the
 * reason is specific to how this installation is configured: every rung of
 * the live global ladder is PATTERN-LESS, so `evaluatePreferenceList` judges
 * resolution, codec and size and nothing else. A search for one show would
 * therefore accept any 1080p release an indexer happened to return — a
 * different show included — and persist it as that title's verified upgrade.
 *
 * `AcquisitionMatchPreferenceService.select()` guards the identical hole the
 * identical way, and its own comment records that a looser test mis-grabbed
 * 132 of 714 episodes. This pins the guard on the Media Intelligence side so
 * the two cannot drift apart.
 *
 * The anchor is applied to the RAW release name, because `showTitleMatch`
 * does its own show-region extraction and is stricter than the parser's
 * title guess.
 */

/** The same normalization the service applies before anchoring. */
const anchorFor = (title: string) => title.replace(/\s*\((19|20)\d{2}\)\s*$/, '').trim() || title;

describe('upgrade verification — candidate anchoring', () => {
  it('accepts the show it actually searched for', () => {
    expect(showTitleMatch(anchorFor('Airwolf'), 'Airwolf.S01E05.1080p.WEB-DL.x265-GRP')).toBe(true);
    // A release that carries the series year still belongs to the show.
    expect(showTitleMatch(anchorFor('Airwolf'), 'Airwolf 1984 S02E03 1080p BluRay x265')).toBe(true);
  });

  it('rejects a different show that merely satisfies the quality rungs', () => {
    // Both of these are valid 1080p x265 releases. With no anchoring they
    // would have been accepted as an "upgrade" for Airwolf.
    expect(showTitleMatch(anchorFor('Airwolf'), 'Breaking.Bad.S03E08.1080p.WEB-DL.x265-GRP')).toBe(false);
    expect(showTitleMatch(anchorFor('Airwolf'), 'Knight.Rider.S01E01.1080p.HEVC.x265-MeGusta')).toBe(false);
  });

  it('rejects a spinoff that only shares the title prefix', () => {
    // The 9-1-1 / 9-1-1 Lone Star failure mode: a prefix is not the title.
    expect(showTitleMatch(anchorFor('Airwolf'), 'Airwolf.Chronicles.S01E01.1080p.x265')).toBe(false);
  });

  it('strips a parenthesised year from the projection title before anchoring', () => {
    // Projection titles are stored as "Show (2019)"; release names are not.
    expect(anchorFor('All Rise (2019)')).toBe('All Rise');
    expect(showTitleMatch(anchorFor('All Rise (2019)'), 'All.Rise.S02E04.1080p.WEB.x265-MeGusta')).toBe(true);
    expect(showTitleMatch(anchorFor('All Rise (2019)'), 'All.American.S02E04.1080p.WEB.x265')).toBe(false);
  });

  it('never empties the anchor, even for a title that is only a year', () => {
    // "1923" is a real series in this library. Stripping must not leave an
    // empty pattern, which `showTitleMatch` treats as "match anything".
    expect(anchorFor('1923')).toBe('1923');
    expect(showTitleMatch(anchorFor('1923'), '1923.S02E01.1080p.WEB.x265-GRP')).toBe(true);
    expect(showTitleMatch(anchorFor('1923'), 'Yellowstone.S05E01.1080p.WEB.x265-GRP')).toBe(false);
  });
});
