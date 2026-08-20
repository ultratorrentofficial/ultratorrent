/**
 * The library answers before the network does.
 *
 * A destination is the one decision where being wrong forks a library: an
 * unknown year drops the `{year}` token and the plan builds a SECOND show
 * folder beside the real one. That happened live — a transient TMDB miss put
 * two Reacher episodes in `TV_Shows/Reacher/` while `TV_Shows/Reacher (2022)/`
 * held the other 28 — and because the provider call is wrapped in a catch, the
 * failure was indistinguishable from an answer.
 *
 * `media_shows` already knows the title and year, cannot rate-limit, cannot
 * time out, and agrees by definition with where the files already are.
 */
import { MediaService } from './media.service';

type Meta = { seriesTitle: string; year?: number } | null;

function build(show: { title: string; year: number | null } | null) {
  const findFirst = jest.fn(async (_args?: { where?: unknown; orderBy?: unknown }) => show);
  /*
   * Typed as a bare shape, not as `MediaService & {…}`: the class holds a
   * PRIVATE `prisma`, and intersecting with it collapses the whole type to
   * `never`. The prototype is still the real one, so the method under test is
   * the shipped implementation.
   */
  const svc = Object.create(MediaService.prototype) as unknown as {
    prisma: unknown;
    showMetaFromLibrary: (
      kind: string,
      title: string | undefined,
      libraryPath?: string,
    ) => Promise<Meta>;
  };
  svc.prisma = { mediaShow: { findFirst } };
  return { svc, findFirst };
}

describe('show metadata from the library', () => {
  it('answers a year-less release from the library’s own record', async () => {
    // `Reacher.S04E04…` carries no year; the library does.
    const { svc } = build({ title: 'Reacher', year: 2022 });
    expect(await svc.showMetaFromLibrary('tv', 'Reacher', '/tv')).toEqual({
      seriesTitle: 'Reacher',
      year: 2022,
    });
  });

  it('matches on the canonical key, so a parsed title finds its stored folder', async () => {
    const { svc, findFirst } = build({ title: 'Reacher', year: 2022 });
    await svc.showMetaFromLibrary('tv', 'Reacher', '/tv');
    const where = (findFirst.mock.calls[0]?.[0]?.where ?? {}) as Record<string, unknown>;
    expect(where).toMatchObject({ path: { startsWith: '/tv/' } });
    expect(where.canonicalKey).toBe('reacher');
  });

  it('prefers the folder holding the most episodes when a library is split', async () => {
    // A split library has more than one candidate; the biggest is where the
    // show actually lives, and the one an import should join.
    const { svc, findFirst } = build({ title: 'Reacher', year: 2022 });
    await svc.showMetaFromLibrary('tv', 'Reacher', '/tv');
    expect(findFirst.mock.calls[0]?.[0]).toMatchObject({ orderBy: { episodeCount: 'desc' } });
  });

  it('falls through for a show the library has never seen', async () => {
    // A genuinely new show still needs the network — this replaces the
    // provider only when there is something local to replace it WITH.
    const { svc } = build(null);
    expect(await svc.showMetaFromLibrary('tv', 'Brand New Show', '/tv')).toBeNull();
  });

  it('leaves films alone', async () => {
    // A movie's year is mandatory in its template and comes from its own title;
    // there is no show record to consult.
    const { svc, findFirst } = build({ title: 'Reacher', year: 2022 });
    expect(await svc.showMetaFromLibrary('movie', 'Jack Reacher', '/movies')).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('returns null rather than throwing when the lookup fails', async () => {
    // This decorates a plan; failing it would trade the whole rename for part.
    const { svc } = build(null);
    svc.prisma = {
      mediaShow: { findFirst: async () => { throw new Error('db down'); } },
    };
    expect(await svc.showMetaFromLibrary('tv', 'Reacher', '/tv')).toBeNull();
  });

  it('handles a show recorded without a year', async () => {
    const { svc } = build({ title: 'Reacher', year: null });
    expect(await svc.showMetaFromLibrary('tv', 'Reacher', '/tv')).toEqual({ seriesTitle: 'Reacher' });
  });
});
