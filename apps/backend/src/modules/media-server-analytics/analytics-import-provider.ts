/**
 * Historical analytics import providers — DISTINCT from MediaServerProvider.
 * A media server is a live integration; an import provider is a one-time /
 * incremental source of historical stats. Tautulli is an import source, never a
 * media server.
 */

export interface ImportContext {
  baseUrl: string;
  apiKey: string;
}

export interface ImportSourceInfo {
  reachable: boolean;
  version?: string;
  totalUsers: number;
  totalHistory: number;
  message?: string;
}

export interface ImportUser {
  providerUserId: string;
  userName: string;
  email?: string;
}

/** A library/section on the source server. */
export interface ImportLibrary {
  sectionId: string;
  name: string;
  type?: string;
}

/** A normalized watch-history record — shared shape across import providers. */
export interface NormalizedHistory {
  providerHistoryId: string;
  providerUserId?: string;
  userName?: string;
  title: string;
  mediaType?: string;
  libraryName?: string;
  device?: string;
  client?: string;
  ipAddress?: string;
  startedAt: Date;
  stoppedAt?: Date;
  watchedSeconds?: number;
  percentComplete?: number;
  playbackMethod?: string;
}

export interface HistoryPage {
  records: NormalizedHistory[];
  total: number;
}

export interface MediaAnalyticsImportProvider {
  readonly type: string;
  testConnection(ctx: ImportContext): Promise<{ ok: boolean; message: string }>;
  getImportSourceInfo(ctx: ImportContext): Promise<ImportSourceInfo>;
  getUsers(ctx: ImportContext): Promise<ImportUser[]>;
  /** The source's libraries, so history can be imported (and labelled) per library. */
  getLibraries(ctx: ImportContext): Promise<ImportLibrary[]>;
  /**
   * A page of watch history. When `sectionId` is given the source filters to that
   * library, and `libraryName` is stamped on every returned record.
   *
   * Tautulli's `get_history` rows carry NO library field at all — not `library_name`,
   * not `section_id` (verified against a live server). The importer nevertheless read
   * `r.library_name`, which is always undefined, so 99% of imported rows landed with a
   * null library and the analytics "Libraries" report attributed nearly everything to
   * a single "Unknown" bucket. The library is knowable only from the section we ASKED
   * for, so we ask per section and stamp it.
   */
  getWatchHistory(
    ctx: ImportContext,
    opts: { start: number; length: number; sectionId?: string; libraryName?: string },
  ): Promise<HistoryPage>;
}

/**
 * Normalize a user-entered base URL: strip trailing slashes and default the
 * scheme to http:// when omitted. Tautulli hosts are commonly entered as
 * `host:8181` — without a scheme `fetch` throws an opaque "Failed to parse URL".
 * Pure — unit-tested.
 */
export function normalizeBaseUrl(input: string): string {
  const trimmed = (input ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

async function tautulliCmd(ctx: ImportContext, cmd: string, params: Record<string, string | number> = {}) {
  const base = normalizeBaseUrl(ctx.baseUrl);
  const qs = new URLSearchParams({ apikey: ctx.apiKey, cmd, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${base}/api/v2?${qs.toString()}`, { signal: ctrl.signal });
    const json: any = await res.json().catch(() => null);
    return { httpOk: res.ok, response: json?.response };
  } finally {
    clearTimeout(timer);
  }
}

function mapTranscode(decision?: string): string | undefined {
  switch ((decision ?? '').toLowerCase()) {
    case 'direct play': return 'directplay';
    case 'copy': case 'direct stream': return 'directstream';
    case 'transcode': return 'transcode';
    default: return decision || undefined;
  }
}

/** Normalize one Tautulli `get_history` row. Pure — unit-tested. */
export function normalizeTautulliHistory(r: any): NormalizedHistory {
  return {
    providerHistoryId: String(r.row_id ?? r.id ?? r.reference_id ?? `${r.user_id}-${r.started}`),
    providerUserId: r.user_id != null ? String(r.user_id) : undefined,
    userName: r.friendly_name || r.user || undefined,
    title: r.full_title || r.title || 'Unknown',
    mediaType: r.media_type || undefined,
    libraryName: r.library_name || undefined,
    device: r.platform || undefined,
    client: r.player || undefined,
    ipAddress: r.ip_address || undefined,
    startedAt: new Date(Number(r.started) * 1000),
    stoppedAt: r.stopped ? new Date(Number(r.stopped) * 1000) : undefined,
    watchedSeconds: r.duration != null ? Number(r.duration) : undefined,
    percentComplete: r.percent_complete != null ? Number(r.percent_complete) : undefined,
    playbackMethod: mapTranscode(r.transcode_decision),
  };
}

export class TautulliAnalyticsImportProvider implements MediaAnalyticsImportProvider {
  readonly type = 'tautulli' as const;

  async testConnection(ctx: ImportContext): Promise<{ ok: boolean; message: string }> {
    try {
      const { httpOk, response } = await tautulliCmd(ctx, 'arnold');
      if (httpOk && response?.result === 'success') return { ok: true, message: 'Connected to Tautulli.' };
      return { ok: false, message: response?.message || `Tautulli responded unexpectedly.` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async getImportSourceInfo(ctx: ImportContext): Promise<ImportSourceInfo> {
    try {
      const [hist, users] = await Promise.all([
        tautulliCmd(ctx, 'get_history', { length: 1 }),
        tautulliCmd(ctx, 'get_users'),
      ]);
      const totalHistory = Number(hist.response?.data?.recordsFiltered ?? hist.response?.data?.recordsTotal ?? 0);
      const userList: any[] = users.response?.data ?? [];
      return { reachable: true, totalHistory, totalUsers: userList.length };
    } catch (err) {
      return { reachable: false, totalHistory: 0, totalUsers: 0, message: (err as Error).message };
    }
  }

  async getUsers(ctx: ImportContext): Promise<ImportUser[]> {
    const { response } = await tautulliCmd(ctx, 'get_users');
    const list: any[] = response?.data ?? [];
    return list
      .filter((u) => u.user_id != null)
      .map((u) => ({ providerUserId: String(u.user_id), userName: u.friendly_name || u.username || 'Unknown', email: u.email || undefined }));
  }

  async getLibraries(ctx: ImportContext): Promise<ImportLibrary[]> {
    const { response } = await tautulliCmd(ctx, 'get_libraries');
    const rows: any[] = response?.data ?? [];
    return rows
      .filter((l) => l?.section_id != null && l?.section_name)
      .map((l) => ({
        sectionId: String(l.section_id),
        name: String(l.section_name),
        type: l.section_type ? String(l.section_type) : undefined,
      }));
  }

  async getWatchHistory(
    ctx: ImportContext,
    opts: { start: number; length: number; sectionId?: string; libraryName?: string },
  ): Promise<HistoryPage> {
    const params: Record<string, string | number> = {
      start: opts.start,
      length: opts.length,
      order_column: 'date',
      order_dir: 'asc',
    };
    if (opts.sectionId) params.section_id = opts.sectionId;

    const { response } = await tautulliCmd(ctx, 'get_history', params);
    const data = response?.data ?? {};
    const rows: any[] = data.data ?? [];
    return {
      // The row itself carries no library — the only thing that knows is the section
      // we filtered by, so stamp that. A row's own value (should a future Tautulli
      // ever supply one) still wins.
      records: rows.map((r) => {
        const rec = normalizeTautulliHistory(r);
        return opts.libraryName ? { ...rec, libraryName: rec.libraryName ?? opts.libraryName } : rec;
      }),
      total: Number(data.recordsFiltered ?? data.recordsTotal ?? rows.length),
    };
  }
}

export function getAnalyticsImportProvider(type: string): MediaAnalyticsImportProvider {
  if (type === 'tautulli') return new TautulliAnalyticsImportProvider();
  throw new Error(`Unsupported analytics import source "${type}".`);
}
