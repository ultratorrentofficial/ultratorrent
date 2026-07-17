/**
 * Reading a `/files/bulk` response.
 *
 * Single-item file endpoints throw on failure, so a rejected promise means the
 * operation failed. `/files/bulk` does NOT: it catches each item's error, records
 * it in `results[]`, and resolves **200 even when every item failed**. Treating a
 * resolved promise as success therefore reports total failure as success — which
 * is exactly what a multi-select move onto existing files used to do.
 *
 * Every caller of `api.files.bulk` must route its response through here.
 */

/** The envelope every `/files/bulk` response uses. */
export type BulkResult = {
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{ path: string; ok: boolean; message?: string }>;
};

/**
 * Narrow an unknown mutation result to a bulk envelope, so a shared runner can
 * tell a bulk call from a single-item one without being told which it ran.
 */
export function isBulkResult(value: unknown): value is BulkResult {
  const v = value as BulkResult | null;
  return !!v && typeof v === 'object' && typeof v.failed === 'number' && Array.isArray(v.results);
}

/** Distinct failure reasons — N items hitting one conflict should read as one reason. */
export function failureReasons(res: BulkResult): string {
  return [...new Set(res.results.filter((r) => !r.ok).map((r) => r.message).filter(Boolean))].join(' · ');
}

/**
 * Combine several bulk envelopes into one. A conflict-aware move runs the clean
 * sources and the resolved conflicts as separate calls, but the operator thought
 * of it as a single action — so it must be reported as one. Ignores null legs (a
 * call that wasn't needed), and returns null if every leg was null.
 */
export function mergeBulkResults(...parts: Array<BulkResult | null | undefined>): BulkResult | null {
  const present = parts.filter((p): p is BulkResult => !!p);
  if (present.length === 0) return null;
  return present.reduce((acc, p) => ({
    total: acc.total + p.total,
    succeeded: acc.succeeded + p.succeeded,
    failed: acc.failed + p.failed,
    results: [...acc.results, ...p.results],
  }));
}

/**
 * How a finished bulk run should be reported:
 * - `success` — every item landed.
 * - `partial` — some landed; something changed, so the view must refresh.
 * - `failed`  — nothing landed; the caller should hold its state (dialog open,
 *               selection intact) so the operation can be corrected and retried.
 */
export function bulkLevel(res: BulkResult): 'success' | 'partial' | 'failed' {
  if (res.failed === 0) return 'success';
  return res.succeeded === 0 ? 'failed' : 'partial';
}
