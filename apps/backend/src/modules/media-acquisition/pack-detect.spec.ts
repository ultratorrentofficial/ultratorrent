import { classifyPack, seriesPackCovers } from './pack-detect';

describe('classifyPack', () => {
  it('classifies a single episode as NOT a pack', () => {
    expect(classifyPack('Mr. D S03E05 1080p WEB-DL x264-GRP').type).toBeNull();
    expect(classifyPack('Mr.D.3x05.720p').type).toBeNull();
    expect(classifyPack('Show Season 3 Episode 5').type).toBeNull();
  });

  it('classifies a lone season marker as a season pack', () => {
    expect(classifyPack('Mr. D S03 1080p WEB-DL x264-GRP')).toMatchObject({ type: 'season', season: 3 });
    expect(classifyPack('Mr.D.Season.3.COMPLETE.720p')).toMatchObject({ type: 'season', season: 3 });
    expect(classifyPack('Mr D Complete Season 3')).toMatchObject({ type: 'season', season: 3 });
  });

  it('classifies a season range as a series pack', () => {
    expect(classifyPack('Mr. D S01-S06 1080p')).toMatchObject({ type: 'series', season: 1, seasonEnd: 6 });
    expect(classifyPack('Mr.D.Seasons.1-6.WEB')).toMatchObject({ type: 'series', season: 1, seasonEnd: 6 });
  });

  it('classifies several discrete season markers as a series pack', () => {
    expect(classifyPack('Mr.D.S01.S02.S03.1080p')).toMatchObject({ type: 'series', season: 1, seasonEnd: 3 });
  });

  it('classifies "complete series" as an open series pack', () => {
    expect(classifyPack('Mr. D The Complete Series 1080p')).toMatchObject({ type: 'series', season: null, seasonEnd: null });
    expect(classifyPack('Mr D COMPLETE 720p x264')).toMatchObject({ type: 'series', season: null });
  });

  it('is not fooled by resolution/other numbers', () => {
    expect(classifyPack('Mr D S02 1080p 10bit').season).toBe(2);
  });

  it('seriesPackCovers respects an explicit range and trusts an open pack', () => {
    expect(seriesPackCovers({ type: 'series', season: 1, seasonEnd: 6 }, [1, 3, 6])).toBe(true);
    expect(seriesPackCovers({ type: 'series', season: 1, seasonEnd: 3 }, [1, 4])).toBe(false);
    expect(seriesPackCovers({ type: 'series', season: null, seasonEnd: null }, [1, 9])).toBe(true);
    expect(seriesPackCovers({ type: 'season', season: 1, seasonEnd: null }, [1])).toBe(false);
  });
});
