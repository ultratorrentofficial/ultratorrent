/**
 * Which series a folder IS, and who gets to say so.
 *
 * Reported live: a metadata refresh on `Magnum P.I. (2018)` matched the 1980
 * series — on a library whose identity had already been corrected to
 * tt7942796 — and there was no way to correct it from the app.
 */
import { MediaShowMetadataService } from './media-show-metadata.service';

const SHOW = {
  id: 's1',
  libraryId: 'lib1',
  title: 'Magnum P.I',
  year: 2018,
  path: '/tv/Magnum P.I. (2018)',
  mediaType: 'tv',
  imdbId: 'tt7942796',
  tmdbId: null as string | null,
};

function build(show = SHOW) {
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    mediaShow: {
      findUnique: jest.fn(async () => show),
      update: jest.fn(async (args: never) => {
        updates.push(args as Record<string, unknown>);
        return { ...show, ...((args as { data: object }).data as object) };
      }),
    },
    mediaItem: { updateMany: jest.fn(async () => ({ count: 97 })) },
    mediaShowMetadata: { upsert: jest.fn(async () => ({})), findUnique: jest.fn(async () => null) },
    mediaSeason: { findMany: jest.fn(async () => []) },
    mediaArtwork: { findMany: jest.fn(async () => []) },
  };
  const audit = { record: jest.fn(async () => undefined) };
  const svc = new MediaShowMetadataService(prisma as never, audit as never, { get: async () => null } as never);
  return { svc, prisma, audit, updates };
}

describe('correcting a show’s identity', () => {
  it('writes the id to the show AND to every episode under it', async () => {
    // The episodes carry the series id too — that is what missing-episode
    // sweeps read — so stopping at the show leaves the library disagreeing
    // with itself.
    const { svc, prisma } = build();
    const res = await svc.setIdentity('s1', { imdbId: 'tt7942796' }, { userId: 'u1' });

    expect(res.episodesUpdated).toBe(97);
    expect(prisma.mediaItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { libraryId: 'lib1', path: { startsWith: '/tv/Magnum P.I. (2018)/' } },
        data: { seriesImdbId: 'tt7942796' },
      }),
    );
  });

  it('drops a stale TMDB id when the IMDb id changes', async () => {
    /*
     * The two are names for one identity. Keeping the old TMDB id beside a
     * corrected IMDb id would let the very next refresh fetch the series the
     * operator just rejected.
     */
    const { svc, updates } = build({ ...SHOW, imdbId: 'tt0080240', tmdbId: '1002' });
    await svc.setIdentity('s1', { imdbId: 'tt7942796' });
    expect((updates[0] as { data: { tmdbId: string | null } }).data.tmdbId).toBeNull();
  });

  it('keeps the TMDB id when the IMDb id is unchanged', async () => {
    const { svc, updates } = build({ ...SHOW, tmdbId: '1002' });
    await svc.setIdentity('s1', { imdbId: SHOW.imdbId });
    expect((updates[0] as { data: { tmdbId: string | null } }).data.tmdbId).toBe('1002');
  });

  it('records what it changed, and what it changed FROM', async () => {
    // An identity rewrite is exactly the operation someone will want to trace
    // later; "it says tt7942796 now" is not enough to explain a library.
    const { svc, audit } = build({ ...SHOW, imdbId: 'tt0080240' });
    await svc.setIdentity('s1', { imdbId: 'tt7942796' }, { userId: 'u1' });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'media.show.identity_set',
        metadata: expect.objectContaining({ imdbId: 'tt7942796', was: { imdbId: 'tt0080240', tmdbId: null } }),
      }),
    );
  });
});
