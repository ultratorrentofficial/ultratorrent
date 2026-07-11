import { Prisma } from '@prisma/client';
import { AcquisitionWatchlistService } from '../watchlist.service';
import { ImdbSeriesResolver } from '../imdb-series-resolver.service';

function build(existing: Record<string, unknown> | null = null) {
  const prisma = {
    mediaAcquisitionWatchlistItem: {
      findUnique: jest.fn().mockResolvedValue({ id: 'w1', title: 'The Rookie', externalIds: existing }),
      update: jest.fn().mockImplementation(({ data }: any) => ({ id: 'w1', ...data })),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const realtime = { broadcast: jest.fn() };
  const moduleRef = { get: jest.fn() };
  const resolver = new ImdbSeriesResolver(prisma as any);
  const svc = new AcquisitionWatchlistService(prisma as any, audit as any, realtime as any, moduleRef as any, resolver);
  return { svc, prisma };
}

const written = (prisma: any) => prisma.mediaAcquisitionWatchlistItem.update.mock.calls[0][0].data;

describe('AcquisitionWatchlistService.update — externalIds', () => {
  it('persists an IMDb id set on an item that had none', async () => {
    const { svc, prisma } = build(null);

    await svc.update('w1', { externalIds: { imdb: 'tt7587890' } });

    expect(written(prisma).externalIds).toEqual({ imdb: 'tt7587890' });
  });

  it('overwrites an existing IMDb id', async () => {
    const { svc, prisma } = build({ imdb: 'tt0000001' });

    await svc.update('w1', { externalIds: { imdb: 'tt7587890' } });

    expect(written(prisma).externalIds).toEqual({ imdb: 'tt7587890' });
  });

  it('trims whitespace around the submitted id', async () => {
    const { svc, prisma } = build(null);

    await svc.update('w1', { externalIds: { imdb: '  tt7587890 ' } });

    expect(written(prisma).externalIds).toEqual({ imdb: 'tt7587890' });
  });

  it('keeps providers the edit form never showed (imdb-only patch must not wipe tvdb)', async () => {
    const { svc, prisma } = build({ tvdb: '12345' });

    await svc.update('w1', { externalIds: { imdb: 'tt7587890' } });

    expect(written(prisma).externalIds).toEqual({ tvdb: '12345', imdb: 'tt7587890' });
  });

  it('clears just that provider when the field is submitted blank', async () => {
    const { svc, prisma } = build({ imdb: 'tt7587890', tvdb: '12345' });

    await svc.update('w1', { externalIds: { imdb: '' } });

    expect(written(prisma).externalIds).toEqual({ tvdb: '12345' });
  });

  it('nulls the column once the last provider is cleared', async () => {
    const { svc, prisma } = build({ imdb: 'tt7587890' });

    await svc.update('w1', { externalIds: { imdb: '   ' } });

    expect(written(prisma).externalIds).toBe(Prisma.JsonNull);
  });

  it('leaves stored ids untouched when the patch omits externalIds', async () => {
    const { svc, prisma } = build({ imdb: 'tt7587890' });

    await svc.update('w1', { title: 'The Rookie' });

    expect(written(prisma).externalIds).toBeUndefined();
  });
});
