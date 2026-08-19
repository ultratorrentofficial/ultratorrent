/**
 * An item knows where it sits.
 *
 * Reported live: Library Browser → TV Shows → sort by Recently added → a show →
 * an episode, and from there the only ways out were "Media Items" and the
 * sidebar, both of which land somewhere else entirely. A trail needs the show's
 * browser KEY, and that is derived from the folder — computed on the server so
 * the client and the series listing cannot disagree about what identifies a
 * show.
 */
import { MediaItemService } from './media-item.service';
import { decodeSeriesKey } from './series-grouping';

function build(item: Record<string, unknown>) {
  const prisma = { mediaItem: { findUnique: jest.fn(async () => item) } };
  return new MediaItemService(prisma as never);
}

const episode = {
  id: 'e1',
  title: 'The Reckoning',
  mediaType: 'tv',
  season: 2,
  episode: 148,
  libraryId: 'lib1',
  path: '/tv/Beyond the Gates (2025)/Season 2/Beyond the Gates - S02E148.mkv',
  library: { id: 'lib1', name: 'TV Shows', path: '/tv' },
};

describe('item breadcrumb', () => {
  it('names the library and the show an episode belongs to', async () => {
    const res = (await build(episode).get('e1')) as never as {
      breadcrumb: { libraryName: string; showKey: string; showTitle: string };
    };

    expect(res.breadcrumb.libraryName).toBe('TV Shows');
    expect(res.breadcrumb.showTitle).toBe('Beyond the Gates');
    // The key must decode to the show FOLDER, which is what the browser opens.
    expect(decodeSeriesKey(res.breadcrumb.showKey)).toEqual({
      kind: 'dir',
      value: '/tv/Beyond the Gates (2025)',
    });
  });

  it('gives a film no show level, because a library holds it directly', async () => {
    const res = (await build({
      ...episode,
      mediaType: 'movie',
      season: null,
      episode: null,
      title: 'Michael',
      path: '/movies/Michael (2026)/Michael (2026).mkv',
      library: { id: 'lib2', name: 'Movies', path: '/movies' },
    }).get('m1')) as never as { breadcrumb: { showKey: string | null; libraryName: string } };

    expect(res.breadcrumb.showKey).toBeNull();
    expect(res.breadcrumb.libraryName).toBe('Movies');
  });

  it('falls back to the title for an episode sitting in the library root', async () => {
    // No show folder to climb to, so the group resolves by title instead —
    // the same fallback the series listing uses.
    const res = (await build({
      ...episode,
      path: '/tv/Beyond the Gates - S02E148.mkv',
    }).get('e1')) as never as { breadcrumb: { showKey: string } };

    expect(decodeSeriesKey(res.breadcrumb.showKey).kind).toBe('title');
  });
});
