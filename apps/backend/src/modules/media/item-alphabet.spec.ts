/**
 * The A–Z rail's aggregate and the anchor it drives.
 *
 * Two properties matter and neither is obvious from the code:
 *
 * - the aggregate always returns **all 27 entries**, so the rail can disable a
 *   letter in place instead of reflowing as a library grows;
 * - the listing **anchors** at the letter (`>=`) rather than filtering to it,
 *   so landing on M keeps N, O, P below and scrolling continues.
 */
import { Prisma } from '@prisma/client';
import { MediaItemService } from './media-item.service';

function build(rows: Array<{ letter: string; count: number }> = []) {
  const captured: { sql?: string; args?: unknown[]; where?: unknown } = {};
  const prisma = {
    $queryRaw: jest.fn(async (q: Prisma.Sql) => {
      captured.sql = q.sql;
      captured.args = q.values;
      return rows.map((r) => ({ letter: r.letter, count: BigInt(r.count) }));
    }),
    mediaItem: {
      count: jest.fn(async () => 0),
      findMany: jest.fn(async (args: { where?: unknown }) => {
        captured.where = args.where;
        return [];
      }),
    },
  };
  return { svc: new MediaItemService(prisma as never), prisma, captured };
}

describe('alphabet aggregate', () => {
  it('returns all 27 entries, in order, zero-filled', async () => {
    const { svc } = build([{ letter: 'A', count: 3 }, { letter: 'M', count: 12 }]);
    const out = await svc.alphabet({ libraryId: 'lib-1' });

    expect(out).toHaveLength(27);
    expect(out[0].letter).toBe('#');
    expect(out[1].letter).toBe('A');
    expect(out[26].letter).toBe('Z');
    expect(out.find((e) => e.letter === 'M')!.count).toBe(12);
    // The point of zero-filling: the client disables in place rather than
    // omitting, so the rail keeps a stable shape.
    expect(out.find((e) => e.letter === 'Q')!.count).toBe(0);
  });

  it('groups in SQL rather than counting rows in Node', async () => {
    // Pulling one row per item back to count first characters would move 25k
    // rows on this library's TV shows to produce 27 numbers.
    const { svc, prisma, captured } = build();
    await svc.alphabet({ libraryId: 'lib-1' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.mediaItem.findMany).not.toHaveBeenCalled();
    expect(captured.sql).toMatch(/GROUP BY/i);
    expect(captured.sql).toMatch(/count\(\*\)/i);
  });

  it('binds its filters rather than interpolating them', async () => {
    const { svc, captured } = build();
    await svc.alphabet({ libraryId: 'lib-1', search: "O'Brien" });
    // A title is arbitrary text from a filename; it must never reach the SQL
    // string itself.
    expect(captured.sql).not.toContain("O'Brien");
    expect(captured.args).toEqual(expect.arrayContaining(['lib-1', "%O'Brien%"]));
  });

  it('converts bigint counts to numbers', async () => {
    // `count(*)::bigint` arrives as a BigInt, which does not survive JSON.
    const { svc } = build([{ letter: 'A', count: 7 }]);
    const out = await svc.alphabet({});
    expect(typeof out.find((e) => e.letter === 'A')!.count).toBe('number');
  });
});

describe('startsAt anchors the listing', () => {
  const whereOf = (captured: { where?: unknown }) =>
    (captured.where ?? {}) as { title?: unknown };

  it('anchors at the letter with >=, not a prefix match', async () => {
    const { svc, captured } = build();
    await svc.list({ libraryId: 'lib-1', startsAt: 'M' });
    // `startsWith` would strand the reader inside M; `gte` keeps N, O, P below.
    expect(whereOf(captured).title).toEqual({ gte: 'M' });
  });

  it('upper-cases and takes a single character', async () => {
    const { svc, captured } = build();
    await svc.list({ libraryId: 'lib-1', startsAt: 'mmm' });
    expect(whereOf(captured).title).toEqual({ gte: 'M' });
  });

  it('applies no predicate for "#", which sorts at the head anyway', async () => {
    const { svc, captured } = build();
    await svc.list({ libraryId: 'lib-1', startsAt: '#' });
    expect(whereOf(captured).title).toBeUndefined();
  });

  it('ignores nonsense rather than producing an empty listing', async () => {
    for (const bad of ['', '  ', '42', '!!']) {
      const { svc, captured } = build();
      await svc.list({ libraryId: 'lib-1', startsAt: bad });
      expect(whereOf(captured).title).toBeUndefined();
    }
  });

  it('yields to an active search, which is the more specific intent', async () => {
    const { svc, captured } = build();
    await svc.list({ libraryId: 'lib-1', search: 'dune', startsAt: 'M' });
    expect(whereOf(captured).title).toEqual({ contains: 'dune', mode: 'insensitive' });
  });
});
