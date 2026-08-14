import { PlaybackAggregateService } from './playback-aggregate.service';
import { aggregatePlays } from './domain/playback-aggregate';
import { isNeverWatched } from './domain/playback-aggregate';

/**
 * The regression this service exists to prevent, and then the one its first
 * version shipped with.
 *
 * A film nobody watched appears in no history. Keying "measured" off the mere
 * existence of an aggregate row therefore left exactly the items a never-watched
 * policy looks for permanently unmeasured — matched, then excluded, run after
 * run. Having read the whole history and not found the film IS the measurement.
 */
function build(opts: { history: unknown[]; items: unknown[] }) {
  const created: unknown[][] = [];
  const prisma = {
    mediaServerWatchHistory: { findMany: jest.fn().mockResolvedValue(opts.history) },
    mediaItem: { findMany: jest.fn().mockResolvedValue(opts.items) },
    mediaPlaybackAggregate: {
      count: jest.fn().mockResolvedValue(0),
      deleteMany: jest.fn().mockReturnValue({ __op: 'delete' }),
      createMany: jest.fn().mockImplementation(({ data }: { data: unknown[] }) => {
        created.push(data);
        return { __op: 'create' };
      }),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const svc = new PlaybackAggregateService(prisma as never);
  return { svc, prisma, rows: () => created.flat() as Array<Record<string, unknown>> };
}

const movie = (id: string, title: string) => ({ id, title, year: null, mediaType: 'movie' });
/*
 * `startedAt` varies per play on purpose: aggregation dedupes on
 * viewer+start-time so a re-import cannot double-count, and two plays sharing a
 * timestamp are one session by that rule.
 */
const play = (title: string, pct: number, day = 1) => ({
  title, mediaType: 'movie', userName: 'someone',
  startedAt: new Date(`2026-08-0${day}T00:00:00Z`), stoppedAt: null,
  watchedSeconds: 600, percentComplete: pct,
});

describe('PlaybackAggregateService.rebuild', () => {
  it('writes a measured ZERO for a film that is not in the history', async () => {
    const { svc, rows } = build({
      history: [play('Watched Film', 100)],
      items: [movie('a', 'Watched Film'), movie('b', 'Unwatched Film')],
    });

    const result = await svc.rebuild();

    // Both items get a row — the unwatched one is the whole point.
    expect(result.written).toBe(2);
    expect(result.itemsWithPlayback).toBe(1);
    expect(result.itemsWithoutPlayback).toBe(1);

    const unwatched = rows().find((r) => r.mediaItemId === 'b')!;
    expect(unwatched.completedPlayCount).toBe(0);
    expect(unwatched.startedPlayCount).toBe(0);
    expect(unwatched.lastPlayedAt).toBeNull();
    expect(unwatched.sourceRowCount).toBe(0);
  });

  it('produces facts a never-watched policy actually matches on', () => {
    // The end-to-end claim, at the level the evaluator reads: a zero aggregate
    // IS "never watched", where an absent row was merely "unmeasured".
    expect(isNeverWatched(aggregatePlays([]))).toBe(true);
  });

  it('records the real counts for a film that was watched', async () => {
    const { svc, rows } = build({
      history: [play('Watched Film', 100, 1), play('Watched Film', 40, 2)],
      items: [movie('a', 'Watched Film')],
    });

    await svc.rebuild();

    const watched = rows().find((r) => r.mediaItemId === 'a')!;
    expect(watched.completedPlayCount).toBe(1); // only the 100% play completes
    expect(watched.startedPlayCount).toBe(2); // two distinct sessions
    expect(isNeverWatched(aggregatePlays([play('Watched Film', 100)]))).toBe(false);
  });

  it('writes NOTHING when there is no history to read', async () => {
    /*
     * The safety that pays for zero rows. An empty history table is what a
     * broken analytics feed looks like, and declaring the whole library
     * never-watched on the strength of it is how a purge policy deletes
     * everything. No history → no rows → unmeasured, as before.
     */
    const { svc, prisma, rows } = build({
      history: [],
      items: [movie('a', 'Some Film'), movie('b', 'Another Film')],
    });

    const result = await svc.rebuild();

    expect(result.written).toBe(0);
    expect(rows()).toHaveLength(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('replaces the table in a single transaction', async () => {
    // The gap between delete and insert is a window where everything reads as
    // unmeasured; a cleanup run landing in it would exclude the whole library.
    const { svc, prisma } = build({
      history: [play('Watched Film', 100)],
      items: [movie('a', 'Watched Film')],
    });

    await svc.rebuild();

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.mediaPlaybackAggregate.deleteMany).toHaveBeenCalledTimes(1);
  });
});
