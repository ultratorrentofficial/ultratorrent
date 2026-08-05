import { accrue, isEmpty, shareRatio, TransferBaseline } from './accrual';

/**
 * The ledger's arithmetic.
 *
 * One property matters more than the rest: the total must never fall. Every
 * test here is ultimately about that, because a total that can fall is exactly
 * the bug this module replaces — stats derived by summing whatever torrents the
 * engine still happens to hold.
 */
const prior = (
  entries: Record<string, [number, number]>,
): Map<string, TransferBaseline> =>
  new Map(
    Object.entries(entries).map(([hash, [d, u]]) => [
      hash,
      { downloaded: BigInt(d), uploaded: BigInt(u) },
    ]),
  );

const reading = (hash: string, downloaded: number, uploaded: number) => ({
  hash,
  downloaded: BigInt(downloaded),
  uploaded: BigInt(uploaded),
});

describe('banking what moved since the last look', () => {
  it('adds the difference, not the level', () => {
    // The engine reports 500 downloaded; 300 of that was already banked, so
    // only 200 is new. Adding the level instead would compound every sync.
    const out = accrue([reading('a', 500, 120)], prior({ a: [300, 100] }));
    expect(out.downloaded).toBe(200n);
    expect(out.uploaded).toBe(20n);
  });

  it('adds nothing when a torrent sat idle', () => {
    const out = accrue([reading('a', 300, 100)], prior({ a: [300, 100] }));
    expect(isEmpty(out)).toBe(true);
  });

  it('sums across every torrent in the pass', () => {
    const out = accrue(
      [reading('a', 150, 10), reading('b', 250, 20), reading('c', 5, 0)],
      prior({ a: [100, 0], b: [200, 20], c: [0, 0] }),
    );
    expect(out.downloaded).toBe(50n + 50n + 5n);
    expect(out.uploaded).toBe(10n);
  });

  it('handles counters far beyond a 32-bit range', () => {
    // Petabyte-scale totals are the reason these are BigInt and not number.
    const huge = 9_000_000_000_000_000;
    const out = accrue(
      [reading('a', huge + 1000, 0)],
      prior({ a: [huge, 0] }),
    );
    expect(out.downloaded).toBe(1000n);
  });
});

describe('a torrent seen for the first time', () => {
  it('contributes nothing', () => {
    /*
     * The property that stops the history doubling on the first pass after an
     * engine is adopted: its baseline already includes every torrent it holds,
     * so counting their levels here would add the same bytes twice.
     */
    const out = accrue([reading('new', 4_000, 900)], prior({}));
    expect(out.downloaded).toBe(0n);
    expect(out.uploaded).toBe(0n);
    expect(out.firstSightings).toBe(1);
  });

  it('starts counting from the pass after', () => {
    const first = accrue([reading('new', 4_000, 900)], prior({}));
    expect(first.downloaded).toBe(0n);

    // Once a snapshot exists, the torrent behaves like any other.
    const second = accrue([reading('new', 4_500, 950)], prior({ new: [4_000, 900] }));
    expect(second.downloaded).toBe(500n);
    expect(second.uploaded).toBe(50n);
  });

  it('does not let a newcomer mask a neighbour that did move', () => {
    const out = accrue(
      [reading('new', 9_999, 9_999), reading('known', 200, 50)],
      prior({ known: [100, 25] }),
    );
    expect(out.downloaded).toBe(100n);
    expect(out.firstSightings).toBe(1);
  });
});

describe('a counter that moves backwards', () => {
  it('banks what moved since the reset rather than a negative', () => {
    /*
     * A torrent removed and re-added restarts at zero. Banking `current - prior`
     * would subtract its entire history from the ledger — the total would fall,
     * which is the one thing that must never happen.
     */
    const out = accrue([reading('a', 40, 5)], prior({ a: [10_000, 3_000] }));
    expect(out.downloaded).toBe(40n);
    expect(out.uploaded).toBe(5n);
    expect(out.resets).toBe(1);
  });

  it('never produces a negative total, whatever the readings', () => {
    const out = accrue(
      [reading('a', 0, 0), reading('b', 1, 0), reading('c', 0, 0)],
      prior({ a: [10_000, 5_000], b: [10_000, 5_000], c: [10_000, 5_000] }),
    );
    expect(out.downloaded >= 0n).toBe(true);
    expect(out.uploaded >= 0n).toBe(true);
  });

  it('counts one reset per torrent, not one per counter', () => {
    // Both counters going backwards together is how a re-add presents; that is
    // a single event, and counting it twice would overstate the instability.
    const out = accrue([reading('a', 0, 0)], prior({ a: [500, 200] }));
    expect(out.resets).toBe(1);
  });

  it('notices a reset even when only one counter fell', () => {
    const out = accrue([reading('a', 900, 0)], prior({ a: [800, 400] }));
    expect(out.resets).toBe(1);
    expect(out.downloaded).toBe(100n);
    expect(out.uploaded).toBe(0n);
  });

  it('is not empty when a reset happened with no bytes moved', () => {
    // Zero delta but a real event: the caller must still persist the reset
    // count, or a resetting engine would look perfectly stable.
    const out = accrue([reading('a', 0, 0)], prior({ a: [500, 200] }));
    expect(isEmpty(out)).toBe(false);
  });
});

describe('a torrent that has vanished', () => {
  it('takes nothing with it', () => {
    /*
     * The whole point. Two torrents were banked last pass; one is gone. The
     * ledger accrues from what remains and the departed torrent's history stays
     * where it was banked — nothing here can subtract it.
     */
    const out = accrue([reading('stays', 100, 10)], prior({ stays: [100, 10], gone: [50_000, 20_000] }));
    expect(isEmpty(out)).toBe(true);
  });

  it('accrues normally when every torrent is gone at once', () => {
    const out = accrue([], prior({ a: [50_000, 20_000], b: [1_000, 500] }));
    expect(out.downloaded).toBe(0n);
    expect(out.uploaded).toBe(0n);
  });
});

describe('share ratio', () => {
  it('divides uploaded by downloaded', () => {
    expect(shareRatio(1000n, 500n)).toBeCloseTo(0.5, 6);
    expect(shareRatio(1000n, 2500n)).toBeCloseTo(2.5, 6);
  });

  it('reports zero rather than infinity when nothing was downloaded', () => {
    // An engine that only ever seeded local files has no meaningful ratio, and
    // Infinity renders as garbage.
    expect(shareRatio(0n, 5000n)).toBe(0);
  });

  it('keeps precision at petabyte scale', () => {
    const downloaded = 8_000_000_000_000_000n;
    expect(shareRatio(downloaded, downloaded / 4n)).toBeCloseTo(0.25, 6);
  });
});
