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
  getWatchHistory(ctx: ImportContext, opts: { start: number; length: number }): Promise<HistoryPage>;
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

  async getWatchHistory(ctx: ImportContext, opts: { start: number; length: number }): Promise<HistoryPage> {
    const { response } = await tautulliCmd(ctx, 'get_history', { start: opts.start, length: opts.length, order_column: 'date', order_dir: 'asc' });
    const data = response?.data ?? {};
    const rows: any[] = data.data ?? [];
    return {
      records: rows.map(normalizeTautulliHistory),
      total: Number(data.recordsFiltered ?? data.recordsTotal ?? rows.length),
    };
  }
}

export function getAnalyticsImportProvider(type: string): MediaAnalyticsImportProvider {
  if (type === 'tautulli') return new TautulliAnalyticsImportProvider();
  throw new Error(`Unsupported analytics import source "${type}".`);
}
