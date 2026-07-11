import { ImdbSeriesResolver, catalogueTitleKey, seriesLookupCandidates } from '../imdb-series-resolver.service';
import { Table } from './fake-prisma';

function build() {
  const prisma = {
    iMDbTitle: new Table('title'),
    iMDbEpisode: new Table('ep'),
  } as any;
  return { prisma, resolver: new ImdbSeriesResolver(prisma) };
}

/** Seed a series with `episodes` catalogued episodes. */
function seedSeries(
  prisma: any,
  tconst: string,
  primaryTitle: string,
  startYear: number | null,
  episodes: number,
  titleType = 'tvSeries',
) {
  prisma.iMDbTitle.rows.push({ tconst, primaryTitle, startYear, titleType });
  for (let i = 0; i < episodes; i++) {
    prisma.iMDbEpisode.rows.push({
      episodeTitleId: `${tconst}-e${i}`,
      parentTitleId: tconst,
      seasonNumber: 1,
      episodeNumber: i + 1,
    });
  }
}

describe('catalogueTitleKey', () => {
  it('folds accents, punctuation, spacing and case to one key', () => {
    expect(catalogueTitleKey('90 Day Fiancé')).toBe(catalogueTitleKey('90 Day Fiance'));
    expect(catalogueTitleKey('FBI: Most Wanted')).toBe(catalogueTitleKey('FBI Most Wanted'));
    expect(catalogueTitleKey('Chicago P.D.')).toBe(catalogueTitleKey('Chicago PD'));
    expect(catalogueTitleKey('Law & Order')).toBe(catalogueTitleKey('Law and Order'));
  });

  it('keeps genuinely different shows apart', () => {
    expect(catalogueTitleKey('90 Day Fiance')).not.toBe(catalogueTitleKey('90 Day Fiance: Pillow Talk'));
  });
});

describe('seriesLookupCandidates', () => {
  // Every one of these is a real never-renamed folder that the sweep left unmatched.
  const titles = (raw: string) => seriesLookupCandidates(raw, null).map((a) => a.title);

  it('drops the season token a season pack leaves in the parsed title', () => {
    expect(titles('Criminal.Minds.S18.1080p.x265-ELiTE')).toContain('Criminal Minds');
    expect(titles('The.Peripheral.S01.WEBRip.x265-ION265')).toContain('The Peripheral');
    expect(titles('From.S04.1080p.WEBRip.10Bit.DDP5.1.x265-NeoNoir')).toContain('From');
  });

  it('drops a tracker/site stamp glued to the front', () => {
    expect(titles('www.Torrenting.com - Black.Snow.S02E04.720p.HEVC.x265-MeGusta')).toContain('Black Snow');
    expect(titles('www.UIndex.org    -    Ancient Aliens S22E04 720p WEB H264-JFF')).toContain('Ancient Aliens');
  });

  it('pulls the show out of an episode release name', () => {
    expect(titles('Ahsoka.S01E03.WEB.x264-TORRENTGALAXY[TGx]')).toContain('Ahsoka');
  });

  it('tries the folder name as-is first, and leaves a clean title untouched', () => {
    expect(seriesLookupCandidates('Supergirl', 2015)[0]).toEqual({ title: 'Supergirl', year: 2015 });
    expect(titles('Supergirl')).toEqual(['Supergirl']);
  });
});

describe('ImdbSeriesResolver.resolveFolder', () => {
  it('resolves a season pack whose folder was never renamed', async () => {
    const { prisma, resolver } = build();
    seedSeries(prisma, 'ttCM', 'Criminal Minds', 2005, 331);

    await expect(resolver.resolveFolder('Criminal.Minds.S18.1080p.x265-ELiTE', null)).resolves.toMatchObject({
      tconst: 'ttCM',
    });
  });

  it('resolves through a tracker prefix', async () => {
    const { prisma, resolver } = build();
    seedSeries(prisma, 'ttBS', 'Black Snow', 2022, 12);

    await expect(
      resolver.resolveFolder('www.Torrenting.com - Black.Snow.S02E04.720p.HEVC.x265-MeGusta', null),
    ).resolves.toMatchObject({ tconst: 'ttBS' });
  });

  it('strips a studio brand IMDb does not carry ("Marvel\'s The Punisher" is just "The Punisher")', async () => {
    const { prisma, resolver } = build();
    seedSeries(prisma, 'ttPUN', 'The Punisher', 2017, 26); // the real tt5675620 shape
    seedSeries(prisma, 'ttPUN24', 'The Punisher', 2024, 1); // a newer same-named stub must lose

    await expect(resolver.resolveFolder('Marvels.The.Punisher.S01.WEBRip.x265-ION265', null)).resolves.toMatchObject({
      tconst: 'ttPUN',
    });
  });

  it('never brand-strips a show that really is named that way', async () => {
    const { prisma, resolver } = build();
    seedSeries(prisma, 'ttBOB', "Bob's Burgers", 2011, 290);
    seedSeries(prisma, 'ttBURG', 'Burgers', 2011, 5); // must not win via a brand strip

    await expect(resolver.resolveFolder("Bob's Burgers", null)).resolves.toMatchObject({ tconst: 'ttBOB' });
  });
});

describe('ImdbSeriesResolver.resolve', () => {
  it('matches a title case-insensitively', async () => {
    const { prisma, resolver } = build();
    seedSeries(prisma, 'ttSG', 'Supergirl', 2015, 126);

    await expect(resolver.resolve('supergirl', 2015)).resolves.toMatchObject({ tconst: 'ttSG', episodes: 126 });
  });

  it('matches across accents and punctuation', async () => {
    const { prisma, resolver } = build();
    seedSeries(prisma, 'tt90', '90 Day Fiancé', 2014, 174);
    seedSeries(prisma, 'ttPT', '90 Day Fiancé: Pillow Talk', 2019, 60); // spin-off must not win

    await expect(resolver.resolve('90 Day Fiance', null)).resolves.toMatchObject({ tconst: 'tt90' });
  });

  it('prefers the candidate with the most catalogued episodes over a same-named stub', async () => {
    const { prisma, resolver } = build();
    seedSeries(prisma, 'ttREAL', '9-1-1', 2018, 143);
    seedSeries(prisma, 'ttSTUB', '9-1-1', 1991, 0);

    await expect(resolver.resolve('9-1-1', null)).resolves.toMatchObject({ tconst: 'ttREAL', episodes: 143 });
  });

  it('tolerates a year that is off by one (IMDb startYear vs the folder year)', async () => {
    const { prisma, resolver } = build();
    seedSeries(prisma, 'ttOFF', 'Boundary Show', 2016, 20);

    await expect(resolver.resolve('Boundary Show', 2015)).resolves.toMatchObject({ tconst: 'ttOFF' });
  });

  it('uses the year to pick between same-named shows', async () => {
    const { prisma, resolver } = build();
    seedSeries(prisma, 'ttOLD', 'Ambiguous', 1990, 50);
    seedSeries(prisma, 'ttNEW', 'Ambiguous', 2020, 10);

    await expect(resolver.resolve('Ambiguous', 2020)).resolves.toMatchObject({ tconst: 'ttNEW' });
  });

  it('refuses to guess between same-named shows when the year matches neither', async () => {
    const { prisma, resolver } = build();
    seedSeries(prisma, 'ttOLD', 'Ambiguous', 1990, 50);
    seedSeries(prisma, 'ttNEW', 'Ambiguous', 2020, 10);

    await expect(resolver.resolve('Ambiguous', 2005)).resolves.toBeNull();
  });

  it('still resolves an unambiguous title whose year is simply wrong locally', async () => {
    const { prisma, resolver } = build();
    seedSeries(prisma, 'ttONLY', 'Only One', 2019, 30);

    await expect(resolver.resolve('Only One', 1999)).resolves.toMatchObject({ tconst: 'ttONLY' });
  });

  it('rejects a title with no catalogued episodes (a stub, not the show)', async () => {
    const { prisma, resolver } = build();
    seedSeries(prisma, 'ttEMPTY', 'Empty Show', 2020, 0);

    await expect(resolver.resolve('Empty Show', 2020)).resolves.toBeNull();
  });

  it('ignores non-series title types (an episode id is never a series)', async () => {
    const { prisma, resolver } = build();
    seedSeries(prisma, 'ttEP', 'Truth', 2023, 5, 'tvEpisode');

    await expect(resolver.resolve('Truth', 2023)).resolves.toBeNull();
  });

  it('returns null for an unknown title', async () => {
    const { prisma, resolver } = build();
    seedSeries(prisma, 'ttSG', 'Supergirl', 2015, 126);

    await expect(resolver.resolve('Nonexistent Show', 2020)).resolves.toBeNull();
  });

  it('loads the catalogue once and serves later calls from the cached index', async () => {
    const { prisma, resolver } = build();
    seedSeries(prisma, 'ttA', 'Show A', 2020, 3);
    seedSeries(prisma, 'ttB', 'Show B', 2021, 4);
    const load = jest.spyOn(prisma.iMDbTitle, 'findMany');

    await resolver.resolve('Show A', 2020);
    await resolver.resolve('Show B', 2021);

    expect(load).toHaveBeenCalledTimes(1); // the 8.9M-row table is not re-read per show
  });
});
