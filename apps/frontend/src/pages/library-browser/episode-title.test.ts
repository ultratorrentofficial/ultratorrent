import { describe, expect, it } from 'vitest';
import { episodeTitleOf, titleFromFilename } from './episode-title';

describe('titleFromFilename', () => {
  it('reads what the renamer wrote', () => {
    expect(titleFromFilename('/tv/S/Season 1/A Gentleman in Moscow - S01E01 - A Master of Circumstance.mkv'))
      .toBe('A Master of Circumstance');
  });

  it('anchors on the episode marker, not on the first dash', () => {
    // A show whose NAME contains a dash would otherwise split in the wrong place.
    expect(titleFromFilename('/tv/Spider-Man - S01E02 - Web of Lies.mkv')).toBe('Web of Lies');
  });

  it('handles a multi-episode file', () => {
    expect(titleFromFilename('Show - S01E01-E02 - Double Length.mkv')).toBe('Double Length');
  });

  it('normalizes dotted release separators', () => {
    expect(titleFromFilename('Show.S01E03.Long.Long.Time.mkv')).toBe('Long Long Time');
  });

  it('refuses a scene release tail, which is not a title', () => {
    /*
     * `…S01E05.1080p.HEVC.x265-MeGusta` continues with quality tokens. Showing
     * "1080p HEVC x265-MeGusta" as the episode name is worse than showing
     * nothing.
     */
    for (const f of [
      'A.Gentleman.in.Moscow.S01E05.1080p.HEVC.x265-MeGusta.mkv',
      'Show.S02E01.2160p.WEB-DL.mkv',
      'Show - S01E01 - BluRay.mkv',
    ]) {
      expect(titleFromFilename(f)).toBeNull();
    }
  });

  it('returns null when there is no episode marker at all', () => {
    expect(titleFromFilename('/movies/Dune (2021).mkv')).toBeNull();
    expect(titleFromFilename(null)).toBeNull();
  });

  it('returns null when nothing follows the marker', () => {
    expect(titleFromFilename('Show - S01E01.mkv')).toBeNull();
  });
});

describe('episodeTitleOf', () => {
  const SHOW = 'A Gentleman in Moscow';

  it('prefers the filename, where the renamer puts it', () => {
    expect(episodeTitleOf({
      path: `/tv/x/${SHOW} - S01E02 - An Invitation.mkv`,
      metadataTitle: SHOW,
      showTitle: SHOW,
    })).toBe('An Invitation');
  });

  it('treats metadata equal to the show title as NO episode name', () => {
    /*
     * Measured on a live library: enrichment resolves the SERIES, so every
     * episode's metadata.title was "A Gentleman in Moscow". Rendering it would
     * repeat the series name down every row.
     */
    expect(episodeTitleOf({
      path: '/tv/x/whatever.mkv', metadataTitle: SHOW, showTitle: SHOW,
    })).toBeNull();
  });

  it('uses metadata when it genuinely names the episode', () => {
    // A library enriched at episode level, where the filename is a release name.
    expect(episodeTitleOf({
      path: '/tv/x/Show.S01E05.1080p.HEVC.mkv',
      metadataTitle: 'The Last Rostov',
      showTitle: SHOW,
    })).toBe('The Last Rostov');
  });

  it('ignores case when comparing against the show title', () => {
    expect(episodeTitleOf({
      path: null, metadataTitle: 'a gentleman IN moscow', showTitle: SHOW,
    })).toBeNull();
  });

  it('returns null when nothing knows the episode name', () => {
    expect(episodeTitleOf({ path: 'Show.S01E05.1080p.mkv', metadataTitle: null, showTitle: SHOW }))
      .toBeNull();
  });
});
