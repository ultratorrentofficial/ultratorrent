import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { parseTorrentName } from '../rss/torrent-name-parser';

export interface AuditEntry {
  userId?: string;
  action: string;
  objectType?: string;
  objectId?: string;
  result?: 'success' | 'failure';
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

/**
 * A humanized description of *what media* an audit row acted on. `objectId` alone
 * is an opaque uuid/info-hash, so the trail can't be read without cross-checking
 * ids by hand; this resolves it to the show (and episode, when it targets one).
 */
export interface AuditTarget {
  /** Ready-to-render, e.g. `Silo (2023) — S01E03`. */
  label: string;
  /** Show/movie name incl. year, e.g. `Silo (2023)`. */
  title: string;
  season: number | null;
  episode: number | null;
}

/** Object types whose rows point at media — the only ones we try to name. */
const MEDIA_OBJECT_TYPES = new Set([
  'torrent',
  'wanted_episode',
  'media_item',
  'media_acquisition_action',
  'media_acquisition_watchlist',
  'media_acquisition_watchlist_item',
]);

const pad2 = (n: number) => String(n).padStart(2, '0');

function makeTarget(
  rawTitle: string,
  year: number | null | undefined,
  season: number | null | undefined,
  episode: number | null | undefined,
): AuditTarget | null {
  const name = rawTitle?.trim();
  if (!name) return null;
  // A title that already carries its year ("9-1-1 (2018)") must not gain a second.
  const title = year && !/\(\d{4}\)\s*$/.test(name) ? `${name} (${year})` : name;
  const s = season ?? null;
  const e = episode ?? null;
  const ep = s != null && e != null ? `S${pad2(s)}E${pad2(e)}` : null;
  return { label: ep ? `${title} — ${ep}` : title, title, season: s, episode: e };
}

/**
 * Last-resort naming: many media rows carry the release/torrent name in metadata
 * (`releaseTitle`, `releaseName`, `name`, …). Parsing it yields the show + SxxExx
 * without another query — e.g. `Criminal.Minds.S19E01.1080p…` → `Criminal Minds — S19E01`.
 */
function targetFromMetadata(metadata: unknown): AuditTarget | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const meta = metadata as Record<string, unknown>;
  const raw = ['releaseTitle', 'releaseName', 'name', 'title']
    .map((k) => meta[k])
    .find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  if (!raw) return null;
  const p = parseTorrentName(raw);
  if (!p.title) return null;
  return makeTarget(p.title, p.year, p.season, p.episode ?? p.absoluteEpisode);
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Persist an audit entry. Never throws into the calling request path. */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: entry.userId,
          action: entry.action,
          objectType: entry.objectType,
          objectId: entry.objectId,
          result: entry.result ?? 'success',
          ipAddress: entry.ipAddress,
          userAgent: entry.userAgent,
          metadata: (entry.metadata ?? undefined) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.error(`Failed to write audit log: ${(err as Error).message}`);
    }
  }

  async list(params: { page?: number; pageSize?: number; action?: string }) {
    const page = params.page ?? 1;
    const pageSize = Math.min(params.pageSize ?? 50, 200);
    const where = params.action ? { action: params.action } : {};
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { select: { username: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    const resolved = await this.resolveTargets(rows);
    const items = rows.map((row) => ({
      ...row,
      target:
        resolved.get(`${row.objectType}:${row.objectId}`) ??
        (MEDIA_OBJECT_TYPES.has(row.objectType ?? '')
          ? targetFromMetadata(row.metadata)
          : null),
    }));
    return { items, total, page, pageSize };
  }

  /**
   * Resolve the media a page of audit rows points at, keyed `objectType:objectId`.
   * Batched per object type (three queries for the whole page, never one per row),
   * so naming the trail costs a constant number of round-trips.
   */
  private async resolveTargets(
    rows: Array<{ objectType: string | null; objectId: string | null }>,
  ): Promise<Map<string, AuditTarget>> {
    const idsOf = (type: string) => [
      ...new Set(
        rows
          .filter((r) => r.objectType === type && r.objectId)
          .map((r) => r.objectId as string),
      ),
    ];
    const wantedIds = idsOf('wanted_episode');
    const itemIds = idsOf('media_item');
    const directWlIds = [
      ...idsOf('media_acquisition_watchlist_item'),
      ...idsOf('media_acquisition_watchlist'),
    ];

    const out = new Map<string, AuditTarget>();
    try {
      const [wanted, items] = await Promise.all([
        wantedIds.length
          ? this.prisma.wantedEpisode.findMany({
              where: { id: { in: wantedIds } },
              select: { id: true, seasonNumber: true, episodeNumber: true, watchlistItemId: true },
            })
          : Promise.resolve([]),
        itemIds.length
          ? this.prisma.mediaItem.findMany({
              where: { id: { in: itemIds } },
              select: { id: true, title: true, year: true, season: true, episode: true },
            })
          : Promise.resolve([]),
      ]);

      // The shows behind both directly-referenced watchlist rows and wanted episodes.
      const wlIds = [...new Set([...directWlIds, ...wanted.map((w) => w.watchlistItemId)])];
      const shows = wlIds.length
        ? await this.prisma.mediaAcquisitionWatchlistItem.findMany({
            where: { id: { in: wlIds } },
            select: { id: true, title: true, year: true, seasonNumber: true, episodeNumber: true },
          })
        : [];
      const showById = new Map(shows.map((s) => [s.id, s]));

      for (const w of wanted) {
        const show = showById.get(w.watchlistItemId);
        const t = show && makeTarget(show.title, show.year, w.seasonNumber, w.episodeNumber);
        if (t) out.set(`wanted_episode:${w.id}`, t);
      }
      for (const s of shows) {
        const t = makeTarget(s.title, s.year, s.seasonNumber, s.episodeNumber);
        if (!t) continue;
        out.set(`media_acquisition_watchlist_item:${s.id}`, t);
        out.set(`media_acquisition_watchlist:${s.id}`, t);
      }
      for (const it of items) {
        const t = makeTarget(it.title, it.year, it.season, it.episode);
        if (t) out.set(`media_item:${it.id}`, t);
      }
    } catch (err) {
      // Naming is a nicety — never fail the audit list over it.
      this.logger.warn(`Could not resolve audit targets: ${(err as Error).message}`);
    }
    return out;
  }
}
