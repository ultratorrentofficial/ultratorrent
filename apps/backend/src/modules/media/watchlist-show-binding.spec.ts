import { Logger } from '@nestjs/common';
import { MediaScannerService } from './media-scanner.service';

/**
 * Binding a watchlist entry to the library show it has been monitoring.
 *
 * `libraryShowId` is only ever set from input at add time, and an entry created
 * by Media Discovery cannot supply one — the show is not in the library yet,
 * which is the whole reason it is being monitored. Nothing bound it afterwards,
 * so those entries kept resolving their folder by name on every sweep, which is
 * the fallback meant for shows the library has never seen.
 *
 * The scan is the first moment the binding is knowable, so it happens there.
 * Exercised through the prototype rather than the constructor: the binding is
 * one query and one update, and standing up the scanner's full dependency graph
 * would test the harness instead of the rule.
 */
function svcWith(unbound: any[]) {
  const update = jest.fn(async () => ({}));
  const prisma = {
    mediaAcquisitionWatchlistItem: {
      findMany: jest.fn(async () => unbound),
      update,
    },
  };
  const svc: any = Object.create(MediaScannerService.prototype);
  svc.prisma = prisma;
  svc.logger = new Logger('test');
  return { svc, prisma, update };
}

const entry = (over: any = {}) => ({
  id: 'w1', title: 'The Gilded Age', titleAliases: [], year: 2022,
  externalIds: { tmdb: '76669' }, ...over,
});

describe('binding a watchlist entry to a scanned show', () => {
  it('binds on a matching title and year', async () => {
    const { svc, update } = svcWith([entry()]);
    await svc.bindWatchlistToShow('show-1', 'The Gilded Age', 2022, null);
    expect(update).toHaveBeenCalledWith({ where: { id: 'w1' }, data: { libraryShowId: 'show-1' } });
  });

  /* Ids are proof; a title is a hint. An id on both sides settles it outright. */
  it('binds on a matching IMDb id even when the titles differ', async () => {
    const { svc, update } = svcWith([entry({ title: 'Gilded Age', externalIds: { imdb: 'tt4406178' } })]);
    await svc.bindWatchlistToShow('show-1', 'The Gilded Age', 2022, 'tt4406178');
    expect(update).toHaveBeenCalled();
  });

  it('does not bind when both sides have an id and they disagree', async () => {
    const { svc, update } = svcWith([entry({ externalIds: { imdb: 'tt0000001' } })]);
    await svc.bindWatchlistToShow('show-1', 'The Gilded Age', 2022, 'tt4406178');
    expect(update).not.toHaveBeenCalled();
  });

  /*
   * The Librarians 2007 must not adopt The Librarians 2014's folder. Same title,
   * two works — the year is the only thing separating them.
   */
  it('does not bind two same-titled shows from different years', async () => {
    const { svc, update } = svcWith([entry({ title: 'The Librarians', year: 2014 })]);
    await svc.bindWatchlistToShow('show-1', 'The Librarians', 2007, null);
    expect(update).not.toHaveBeenCalled();
  });

  /* A missing year on either side is not a contradiction. */
  it('binds on title alone when neither side carries a year', async () => {
    const { svc, update } = svcWith([entry({ title: 'Panorama', year: null })]);
    await svc.bindWatchlistToShow('show-1', 'Panorama', null, null);
    expect(update).toHaveBeenCalled();
  });

  it('binds through a title alias', async () => {
    const { svc, update } = svcWith([entry({ title: 'Riverdale', titleAliases: ['Riverdale US'], year: null })]);
    await svc.bindWatchlistToShow('show-1', 'Riverdale US', null, null);
    expect(update).toHaveBeenCalled();
  });

  /*
   * The safety. Only ever fills a blank — an entry already pointing at a show is
   * pointing at one somebody chose, and a scan must not move it.
   */
  it('only ever considers entries with no show bound', async () => {
    const { svc, prisma } = svcWith([]);
    await svc.bindWatchlistToShow('show-1', 'Anything', 2022, null);
    expect(prisma.mediaAcquisitionWatchlistItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ libraryShowId: null }) }),
    );
  });

  it('does nothing when no entry matches', async () => {
    const { svc, update } = svcWith([entry({ title: 'Something Else' })]);
    await svc.bindWatchlistToShow('show-1', 'The Gilded Age', 2022, null);
    expect(update).not.toHaveBeenCalled();
  });
});
