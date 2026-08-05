/**
 * Turning an engine's per-torrent counters into a total that only moves
 * forward.
 *
 * The engine reports a *level* — "this torrent has downloaded 4 GiB" — and that
 * level disappears the moment the torrent is removed. A ledger needs a *flow*:
 * how many bytes moved since we last looked. So every sync we diff each torrent
 * against its previous snapshot and add the difference. Once a delta is banked
 * it belongs to the ledger, and removing the torrent cannot take it back.
 *
 * Pure on purpose. This is the arithmetic the whole feature rests on, and the
 * three cases below are much easier to argue about — and to test — with no
 * database in the way.
 */

/** A torrent's counters as the engine currently reports them. */
export interface TransferReading {
  hash: string;
  downloaded: bigint;
  uploaded: bigint;
}

/** The same counters as of the previous sync, if we have seen this torrent. */
export interface TransferBaseline {
  downloaded: bigint;
  uploaded: bigint;
}

export interface AccrualResult {
  /** Bytes to add to the ledger. Never negative. */
  downloaded: bigint;
  uploaded: bigint;
  /** Torrents whose counter moved backwards since the last reading. */
  resets: number;
  /** Torrents seen for the first time, which contribute nothing this pass. */
  firstSightings: number;
}

export const NO_ACCRUAL: AccrualResult = {
  downloaded: 0n,
  uploaded: 0n,
  resets: 0,
  firstSightings: 0,
};

/**
 * One counter's contribution.
 *
 * Three cases, and the awkward one is the third:
 *
 * - **Unchanged or advanced** — the ordinary case. Bank the difference.
 * - **Backwards** — the counter reset under us. A torrent removed and re-added
 *   starts from zero; so does a recheck, or an engine that lost its state. The
 *   honest reading is that `current` bytes have moved *since the reset*, so
 *   that is what we bank. The alternative — banking `current - prior`, a
 *   negative — would make the ledger go down, which is the exact failure this
 *   whole module exists to prevent.
 * - **Never seen** — handled by the caller, not here.
 */
function contribution(
  prior: bigint,
  current: bigint,
): { delta: bigint; reset: boolean } {
  if (current >= prior) return { delta: current - prior, reset: false };
  return { delta: current, reset: true };
}

/**
 * What this sync should add to the ledger.
 *
 * **A torrent seen for the first time contributes nothing.** That looks like
 * lost bytes and is in fact the opposite: at the moment an engine is adopted,
 * the baseline already accounts for every torrent it holds — seeded from the
 * engine's own all-time figure. Counting those same torrents again here would
 * double the history on the very first pass. The cost is whatever a torrent
 * transferred between appearing and the next sync, which is at most one sync
 * interval (two seconds), and the same convention the sync loop already applies
 * to its automation triggers.
 *
 * Torrents that have *vanished* are not an input. Their bytes were banked while
 * they were still present, which is what makes removal harmless.
 */
export function accrue(
  readings: readonly TransferReading[],
  priorByHash: ReadonlyMap<string, TransferBaseline>,
): AccrualResult {
  let downloaded = 0n;
  let uploaded = 0n;
  let resets = 0;
  let firstSightings = 0;

  for (const reading of readings) {
    const prior = priorByHash.get(reading.hash);
    if (!prior) {
      firstSightings += 1;
      continue;
    }

    const down = contribution(prior.downloaded, reading.downloaded);
    const up = contribution(prior.uploaded, reading.uploaded);
    downloaded += down.delta;
    uploaded += up.delta;
    // One torrent resetting is one reset, even though both of its counters
    // went backwards together — which is the normal way a reset presents.
    if (down.reset || up.reset) resets += 1;
  }

  return { downloaded, uploaded, resets, firstSightings };
}

/** Nothing moved, so there is nothing to write. Lets the caller skip the row. */
export function isEmpty(result: AccrualResult): boolean {
  return result.downloaded === 0n && result.uploaded === 0n && result.resets === 0;
}

/**
 * Share ratio from the ledger's totals.
 *
 * Zero downloaded means undefined, not infinite: an engine that has only ever
 * seeded from local files has no meaningful ratio, and reporting `Infinity`
 * would render as garbage. The previous implementation returned 0 here and this
 * keeps that contract.
 */
export function shareRatio(downloaded: bigint, uploaded: bigint): number {
  if (downloaded <= 0n) return 0;
  // Ratios are small; going through Number after the division keeps precision
  // where it matters without overflowing on petabyte-scale counters.
  return Number((uploaded * 1_000_000n) / downloaded) / 1_000_000;
}
