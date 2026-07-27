import { historyScope } from './history-scope';

const MOVIE = '/media/Movies/12 Strong (2018)/12 Strong (2018) [1080p].mp4';

describe('historyScope', () => {
  it('includes the item path and its containing folder', () => {
    const { paths } = historyScope(MOVIE);
    expect(paths).toContain(MOVIE);
    expect(paths).toContain('/media/Movies/12 Strong (2018)');
  });

  it('derives a stem so sidecars beside the film are attributed to it', () => {
    const { stems } = historyScope(MOVIE);
    expect(stems).toEqual(['/media/Movies/12 Strong (2018)/12 Strong (2018) [1080p]']);
    // What the stem is FOR: these are the paths it has to catch.
    for (const sidecar of [`${stems[0]}.en.srt`, `${stems[0]}.nfo`, `${stems[0]}-thumb.jpg`]) {
      expect(sidecar.startsWith(stems[0])).toBe(true);
    }
  });

  it('covers every file of a multi-part item', () => {
    const parts = [`${MOVIE}`, '/media/Movies/12 Strong (2018)/12 Strong (2018) [1080p]-part2.mp4'];
    const { paths, stems } = historyScope(parts[0], parts);
    for (const p of parts) expect(paths).toContain(p);
    expect(stems).toHaveLength(2);
  });

  it('does not repeat the folder once per file', () => {
    const { paths } = historyScope(MOVIE, [MOVIE, '/media/Movies/12 Strong (2018)/b.mp4']);
    const folder = '/media/Movies/12 Strong (2018)';
    expect(paths.filter((p) => p === folder)).toHaveLength(1);
  });

  it('returns an empty scope for an item with no path, so nothing matches everything', () => {
    // The failure that matters: an empty scope must yield NO operations, never
    // the whole log. `paths: []` makes `= ANY('{}')` false for every row.
    expect(historyScope(null)).toEqual({ paths: [], stems: [] });
    expect(historyScope('   ')).toEqual({ paths: [], stems: [] });
  });

  it('keeps an extensionless path whole as its own stem', () => {
    // `extname` is empty for a leading-dot name, so the stem is the path itself
    // — it still matches only that name, never the whole folder.
    const dotfile = '/media/TV/Show/Season 01/.mkv';
    expect(historyScope(dotfile).stems).toEqual([dotfile]);
    expect('/media/TV/Show/Season 01/other.mkv'.startsWith(dotfile)).toBe(false);
  });

  /**
   * The reason the query compares with `substring(...) =` instead of `LIKE`:
   * these are legal filenames, and as LIKE patterns they match their neighbours.
   */
  it('keeps wildcard characters in paths intact rather than escaping or dropping them', () => {
    const odd = '/media/Movies/100% Wolf (2020)/100% Wolf_2020.mkv';
    const { paths, stems } = historyScope(odd);
    expect(paths).toContain(odd);
    expect(stems[0]).toBe('/media/Movies/100% Wolf (2020)/100% Wolf_2020');
  });
});
