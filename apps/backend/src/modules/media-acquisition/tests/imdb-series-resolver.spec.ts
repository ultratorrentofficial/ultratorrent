import { ImdbSeriesResolver, catalogueTitleKey } from '../imdb-series-resolver.service';
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
