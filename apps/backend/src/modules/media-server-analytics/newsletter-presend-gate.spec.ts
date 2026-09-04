import { MediaServerNewsletterService } from './media-server-newsletter.service';
import { DEFERRAL_WINDOW_MS } from './newsletter-verification';

/**
 * The pre-send gate, end to end through `build()`.
 *
 * Written against the 2026-09-04 Movies issue: nineteen films in the window,
 * six of them with a `tmdb` metadata row holding no overview, no runtime, no
 * rating and no artwork at all. Every one went out as an initial in a grey box.
 */

const LIBRARY = { name: 'Movies' };

/** A library row as `gather()` selects it. */
function row(
  id: string,
  title: string,
  opts: { art?: boolean; overview?: string | null; runtime?: number | null } = {},
) {
  const { art = true, overview = `What ${title} is about.`, runtime = 100 } = opts;
  return {
    id,
    title,
    mediaType: 'movie',
    year: 2026,
    season: null,
    episode: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    library: LIBRARY,
    metadata: { overview, rating: 7, runtime, certification: 'PG', genres: ['Drama'] },
    artwork: art ? [{ id: `art-${id}`, url: null, localPath: `/art/${id}.jpg` }] : [],
  };
}

interface HarnessOpts {
  rows: ReturnType<typeof row>[];
  /** Item ids a repair pass manages to complete. */
  repairs?: Record<string, boolean>;
  deferredItems?: unknown;
}

function harness({ rows, repairs = {}, deferredItems = [] }: HarnessOpts) {
  // Repair mutates the library, so the second gather must see the new state —
  // exactly as it does in production, where the re-read is a fresh query.
  const state = new Map(rows.map((r) => [r.id, r]));
  const repaired = new Set<string>();

  const findMany = jest.fn(async (_args?: any) => [...state.values()]);
  const prisma = {
    mediaItem: { findMany },
    mediaArtwork: { findMany: jest.fn(async () => []) },
    mediaServerIntegration: { findFirst: jest.fn(async () => null) },
  };

  const fetchMetadata = jest.fn(async (itemId: string) => {
    if (!repairs[itemId]) return null;
    const r = state.get(itemId);
    if (r) r.metadata = { ...r.metadata, overview: `Repaired synopsis for ${r.title}.` };
    return {};
  });
  const importFromProvider = jest.fn(async (itemId: string) => {
    if (!repairs[itemId]) return null;
    const r = state.get(itemId);
    if (r) r.artwork = [{ id: `art-${itemId}`, url: null, localPath: `/art/${itemId}.jpg` }];
    repaired.add(itemId);
    return {};
  });

  const svc = new MediaServerNewsletterService(
    prisma as any,
    {} as any, // email
    { record: jest.fn(async () => undefined) } as any,
    { record: jest.fn(async () => undefined), newRun: () => 'run', endRun: jest.fn(), prune: jest.fn() } as any,
    { broadcast: jest.fn() } as any,
    {} as any, // registry
    { effectiveMode: jest.fn(async () => ({ mode: 'attach' as const })), loadAndResize: jest.fn(async () => ({ buf: Buffer.from('x'), contentType: 'image/jpeg' })) } as any,
    { get: jest.fn(() => '0.88.0') } as any,
    { get: jest.fn(async () => undefined) } as any,
    {} as any, // unsub
    { baseUrl: async () => null } as any,
    { fetchMetadata } as any,
    { importFromProvider } as any,
  );

  const newsletter = {
    id: 'nl-1',
    name: 'Movies',
    contentSections: ['movie'],
    dateRangeMode: 'last_days',
    lastDays: 7,
    brandTitle: null,
    deferredItems,
  };

  return {
    build: () => (svc as any).build(newsletter),
    fetchMetadata,
    importFromProvider,
    findMany,
  };
}

/** Titles actually published in the issue. */
const published = (content: any): string[] =>
  content.sections.flatMap((s: any) => s.movies.map((m: any) => m.title));

describe('pre-send verification withholds what it cannot illustrate', () => {
  it('publishes a complete film and withholds one with no artwork', async () => {
    const h = harness({
      rows: [row('a', 'Rose of Nevada'), row('b', 'Leviticus', { art: false, overview: null })],
    });
    const built = await h.build();

    expect(published(built.content)).toEqual(['Rose of Nevada']);
    expect(built.verification.published).toBe(1);
    expect(built.verification.withheld).toHaveLength(1);
    expect(built.verification.withheld[0]).toMatchObject({
      itemId: 'b',
      title: 'Leviticus',
      missing: ['art', 'overview'],
    });
  });

  it('does not count a withheld film in the issue total', async () => {
    const h = harness({
      rows: [row('a', 'Rose of Nevada'), row('b', 'Leviticus', { art: false, overview: null })],
    });
    const built = await h.build();
    // The subject line interpolates {{count}} from this, so a withheld film
    // promising "2 new movies" above one card is the visible half of the bug.
    expect(built.content.totalItems).toBe(1);
  });

  it('repairs what it can before withholding it, and publishes the result', async () => {
    const h = harness({
      rows: [row('a', 'Lola Dust', { art: false, overview: null })],
      repairs: { a: true },
    });
    const built = await h.build();

    // Metadata first, then artwork: the artwork import needs the external id
    // that fetching the metadata writes.
    expect(h.fetchMetadata).toHaveBeenCalledWith('a', {});
    expect(h.importFromProvider).toHaveBeenCalledWith('a', {});
    expect(published(built.content)).toEqual(['Lola Dust']);
    expect(built.verification.repaired).toBe(1);
    expect(built.verification.withheld).toEqual([]);
  });

  it('leaves a complete film alone — no repair traffic for something that is fine', async () => {
    const h = harness({ rows: [row('a', 'Rose of Nevada')] });
    await h.build();
    expect(h.fetchMetadata).not.toHaveBeenCalled();
    expect(h.importFromProvider).not.toHaveBeenCalled();
  });

  it('reports a published film that is only missing a pill, and still publishes it', async () => {
    const h = harness({ rows: [row('a', 'The Eternal Song', { runtime: null })] });
    const built = await h.build();
    expect(published(built.content)).toEqual(['The Eternal Song']);
    expect(built.verification.incomplete).toEqual([
      { title: 'The Eternal Song', advisory: ['runtime'] },
    ]);
  });
});

describe('a withheld film is delayed, not dropped', () => {
  it('carries the withheld item forward for the next issue', async () => {
    const h = harness({
      rows: [row('b', 'Leviticus', { art: false, overview: null })],
    });
    const built = await h.build();
    expect(built.deferred).toEqual([
      { id: 'b', firstDeferredAt: expect.any(String) },
    ]);
  });

  it('gathers a carried item even though it has aged out of the date window', async () => {
    const h = harness({
      rows: [row('a', 'Rose of Nevada')],
      deferredItems: [{ id: 'old', firstDeferredAt: new Date('2026-09-01T00:00:00Z').toISOString() }],
    });
    await h.build();
    const where = (h.findMany.mock.calls[0] as any[])[0].where;
    expect(where.OR).toEqual([
      expect.objectContaining({ createdAt: expect.anything() }),
      { id: { in: ['old'] } },
    ]);
  });

  it('gives up on an item carried past the deferral window and says so', async () => {
    const stale = new Date(Date.now() - DEFERRAL_WINDOW_MS - 60_000).toISOString();
    const h = harness({
      rows: [row('b', 'Middletown', { art: false, overview: null })],
      deferredItems: [{ id: 'b', firstDeferredAt: stale }],
    });
    const built = await h.build();

    expect(built.verification.abandoned).toHaveLength(1);
    expect(built.verification.abandoned[0]).toMatchObject({ itemId: 'b', deferred: true });
    expect(built.verification.withheld).toEqual([]);
    // Abandoned means abandoned: it is not carried a further four weeks.
    expect(built.deferred).toEqual([]);
  });
});
