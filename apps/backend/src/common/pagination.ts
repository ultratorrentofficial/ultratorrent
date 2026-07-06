/**
 * Shared pagination convention for list endpoints. Every "result page" returns
 * `{ items, total, page, pageSize }` and accepts `page`/`pageSize` query params.
 * Keeps skip/take math + clamping in one place so endpoints stay consistent.
 */

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PageParams {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

/** Parse + clamp `page`/`pageSize` (strings from the query) into skip/take. */
export function parsePage(page?: string | number, pageSize?: string | number, defaultSize = 50, maxSize = 200): PageParams {
  const p = Math.max(1, toInt(page, 1));
  const size = Math.min(maxSize, Math.max(1, toInt(pageSize, defaultSize)));
  return { page: p, pageSize: size, skip: (p - 1) * size, take: size };
}

function toInt(v: string | number | undefined, fallback: number): number {
  if (v == null) return fallback;
  const n = typeof v === 'number' ? v : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Wrap a fetched slice + total into the standard page envelope. */
export function pageOf<T>(items: T[], total: number, params: PageParams): Page<T> {
  return { items, total, page: params.page, pageSize: params.pageSize };
}

/**
 * Run a Prisma model's `count` + `findMany` for a page in parallel and return
 * the standard envelope. `delegate` is a Prisma model delegate (e.g.
 * `prisma.auditLog`); `args` are the findMany args minus skip/take. The delegate
 * is loosely typed (`any`) because Prisma's per-model generic signatures can't
 * be expressed structurally here — callers keep their own row types.
 */
export async function paginate<T = unknown>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delegate: { count: (a: any) => Promise<number>; findMany: (a: any) => Promise<T[]> },
  args: { where?: unknown; orderBy?: unknown; include?: unknown; select?: unknown },
  params: PageParams,
): Promise<Page<T>> {
  const [total, items] = await Promise.all([
    delegate.count({ where: args.where }),
    delegate.findMany({ ...args, skip: params.skip, take: params.take }),
  ]);
  return pageOf(items, total, params);
}
