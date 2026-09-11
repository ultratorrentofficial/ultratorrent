/**
 * Ordering discovered titles by when they are released.
 *
 * The inbox orders by `lastSeenAt` — when a provider last reported a title —
 * which is right for "what is new here" and useless for a list of monitored
 * shows, whose whole point is when they arrive. A premiere in November sat
 * above one next week because a provider happened to mention it more recently.
 *
 * The date used is the one the card already shows (`nextRelease` in the
 * frontend's `airtime.ts`): the earliest dated release, taking a release's exact
 * instant when the provider stated one and its calendar date otherwise. Sorting
 * on anything else would put a card under a heading its own date contradicts.
 */

export interface ReleaseInstantLike {
  date: Date | null;
  airsAt: Date | null;
}

export interface ReleaseOrderable {
  id: string;
  title: string;
  releaseDates: ReleaseInstantLike[];
}

/** Epoch milliseconds of the earliest dated release, or null when none has a date. */
export function earliestRelease(dates: readonly ReleaseInstantLike[]): number | null {
  let earliest: number | null = null;
  for (const d of dates) {
    const at = (d.airsAt ?? d.date)?.getTime();
    if (at === undefined || Number.isNaN(at)) continue;
    if (earliest === null || at < earliest) earliest = at;
  }
  return earliest;
}

/**
 * Soonest release first; undated titles last; then title, then id.
 *
 * The id is not decoration. Pages are sliced from this order, and two titles
 * premiering the same day under the same name would otherwise be free to swap
 * between requests — one appearing on both pages and the other on neither.
 */
export function sortByRelease<T extends ReleaseOrderable>(rows: readonly T[]): T[] {
  const keyed = rows.map((row) => ({ row, at: earliestRelease(row.releaseDates) }));
  keyed.sort((a, b) => {
    if (a.at !== b.at) {
      if (a.at === null) return 1;
      if (b.at === null) return -1;
      return a.at - b.at;
    }
    const byTitle = a.row.title.localeCompare(b.row.title);
    if (byTitle !== 0) return byTitle;
    return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
  });
  return keyed.map((k) => k.row);
}

/**
 * One page of titles in release order.
 *
 * The release date lives on a child table and is the MINIMUM over several rows,
 * which Prisma cannot order by. So the filtered set is loaded in its lightest
 * form, ordered here, and only the requested page is loaded in full.
 *
 * Loaders rather than a Prisma delegate, so the one step that is easy to get
 * wrong — `id IN (…)` returns rows in whatever order the database likes — is
 * testable without a database.
 */
export async function pageByRelease<R extends { id: string }>(
  loadCandidates: () => Promise<ReleaseOrderable[]>,
  loadRows: (ids: string[]) => Promise<R[]>,
  page: { skip: number; take: number },
): Promise<{ rows: R[]; total: number }> {
  const candidates = await loadCandidates();
  const ids = sortByRelease(candidates)
    .slice(page.skip, page.skip + page.take)
    .map((row) => row.id);
  if (!ids.length) return { rows: [], total: candidates.length };

  const position = new Map(ids.map((id, i) => [id, i]));
  const rows = (await loadRows(ids))
    .filter((row) => position.has(row.id))
    .sort((a, b) => position.get(a.id)! - position.get(b.id)!);
  return { rows, total: candidates.length };
}
