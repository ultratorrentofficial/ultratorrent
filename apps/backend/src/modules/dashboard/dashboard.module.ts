import { Controller, Get, Injectable, Query, UseGuards } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, TorrentState } from '@ultratorrent/shared';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';

@Injectable()
export class DashboardService {
  constructor(
    private readonly registry: EngineRegistryService,
    private readonly prisma: PrismaService,
  ) {}

  async summary(engineId?: string) {
    const provider = await this.registry.resolve(engineId).catch(() => null);
    const [torrents, stats] = provider
      ? await Promise.all([
          provider.listTorrents().catch(() => []),
          provider.getGlobalStats().catch(() => null),
        ])
      : [[], null];

    const byState = (s: TorrentState) =>
      torrents.filter((t) => t.state === s).length;

    const totalUploaded = torrents.reduce((a, t) => a + t.uploaded, 0);
    const totalDownloaded = torrents.reduce((a, t) => a + t.downloaded, 0);

    return {
      engineOnline: Boolean(provider),
      downloadRate: stats?.downloadRate ?? 0,
      uploadRate: stats?.uploadRate ?? 0,
      totalTorrents: torrents.length,
      downloading: byState(TorrentState.DOWNLOADING),
      paused: byState(TorrentState.PAUSED) + byState(TorrentState.STOPPED),
      completed: torrents.filter((t) => t.progress >= 1).length,
      seeding: byState(TorrentState.SEEDING),
      errored: byState(TorrentState.ERROR),
      ratio: totalDownloaded > 0 ? totalUploaded / totalDownloaded : 0,
      totalUploaded,
      totalDownloaded,
    };
  }

  async recentActivity(limit = 15): Promise<ActivityItem[]> {
    // Scan a wider window than we return so bursts of identical background
    // events — the metadata/artwork/IMDb enrichment sweeps write one audit row
    // per media item, interleaved — can be collapsed into a single line each
    // rather than flooding the feed and crowding out everything else.
    const rows = await this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.max(limit * 8, 120),
      include: { user: { select: { username: true } } },
    });
    return collapseActivity(rows, limit);
  }
}

interface ActivityItem {
  id: string;
  type: string;
  message: string;
  /**
   * Optional secondary line with the specifics of the operation — e.g. the
   * `from → to` of a media rename or the error of a failed download. Rendered
   * muted under the message so the main list stays scannable.
   */
  detail: string | null;
  level: 'info' | 'success' | 'warning' | 'error';
  at: string;
}

export type AuditRow = {
  id: string;
  action: string;
  objectType: string | null;
  result: string;
  metadata: unknown;
  createdAt: Date;
  user: { username: string } | null;
};

const ACRONYMS: Record<string, string> = {
  imdb: 'IMDb',
  tmdb: 'TMDb',
  rss: 'RSS',
  nfo: 'NFO',
  api: 'API',
  url: 'URL',
  ip: 'IP',
  scgi: 'SCGI',
  '2fa': '2FA',
};

export function toActivityItem(row: AuditRow): ActivityItem {
  const meta = asMeta(row.metadata);
  const described = describeActivity(row, meta);
  let message = described.message;
  if (row.user?.username) message += ` · ${row.user.username}`;

  return {
    id: row.id,
    type: row.action,
    message,
    detail: described.detail,
    level: activityLevel(row.action, row.result),
    at: row.createdAt.toISOString(),
  };
}

/**
 * Actions kept as individual rows even when they repeat: the events we
 * deliberately surface per-occurrence (a rename names its show, a download names
 * its release). Everything else that recurs within the window is collapsed.
 */
const NEVER_COLLAPSE = new Set([
  'media.rename',
  'media_acquisition.download.executed',
  'media_acquisition.upgrade.executed',
  'media_acquisition.download.failed',
]);

/**
 * Grouping key for collapsing repeats. Same action + result + actor collapse
 * together; automation additionally keys on the rule name so distinct rules
 * stay separate lines and keep their name.
 */
function burstSignature(r: AuditRow): string {
  const user = r.user?.username ?? '';
  if (r.action === 'automation.rule.executed') {
    return `${r.action}|${r.result}|${user}|${str(asMeta(r.metadata).rule) ?? ''}`;
  }
  return `${r.action}|${r.result}|${user}`;
}

/**
 * Collapse bursty events into one line each. Any action that recurs within the
 * scanned window — the enrichment sweeps (one row per media item), a polled read
 * event, or a rule firing on every completed torrent — is shown once, at its
 * most recent occurrence, with an "N events" count; {@link NEVER_COLLAPSE}
 * actions and one-off events stay individual. Rows arrive newest-first, so
 * emitting each group at its first sighting preserves the ordering.
 */
export function collapseActivity(rows: AuditRow[], limit: number): ActivityItem[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (NEVER_COLLAPSE.has(r.action)) continue;
    const key = burstSignature(r);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const out: ActivityItem[] = [];
  const emitted = new Set<string>();
  for (const r of rows) {
    const key = burstSignature(r);
    const count = NEVER_COLLAPSE.has(r.action) ? 0 : counts.get(key) ?? 0;
    if (count >= 2) {
      if (emitted.has(key)) continue; // group already represented
      emitted.add(key);
      out.push(burstActivityItem(r, count));
    } else {
      out.push(toActivityItem(r));
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** A single collapsed line for a burst: a name-less label (+ actor) and a count. */
function burstActivityItem(rep: AuditRow, count: number): ActivityItem {
  return {
    id: rep.id,
    type: rep.action,
    message: burstLabel(rep),
    detail: `${count} events`,
    level: activityLevel(rep.action, rep.result),
    at: rep.createdAt.toISOString(),
  };
}

/** The collapsed-line label: no per-item name, but keep the rule + actor. */
function burstLabel(rep: AuditRow): string {
  let label: string;
  if (rep.action === 'automation.rule.executed') {
    const rule = str(asMeta(rep.metadata).rule);
    const base = rep.result === 'failure' ? 'Automation failed' : 'Automation';
    label = rule ? `${base}: ${rule}` : base;
  } else {
    label = genericMessage(rep);
  }
  if (rep.user?.username) label += ` · ${rep.user.username}`;
  return label;
}

/**
 * Turn one audit row into the activity feed's `{ message, detail }`. A handful
 * of media operations get purpose-built, plain-language phrasing (so the feed
 * says exactly what media was handled and what was attempted); everything else
 * falls back to the generic verb-from-action rendering.
 */
function describeActivity(
  row: AuditRow,
  meta: Record<string, unknown>,
): { message: string; detail: string | null } {
  const name = activityName(meta);
  const from = str(meta.from);
  const to = str(meta.to);
  const fromTo = from && to ? `${from} → ${to}` : null;
  const failed = row.result === 'failure';

  switch (row.action) {
    case 'media.rename':
      return {
        message: `${failed ? 'Rename failed' : 'Renamed media'}${name ? ` for ${name}` : ''}`,
        detail: fromTo ?? renameCounts(meta),
      };
    case 'media_acquisition.download.executed':
      return { message: `Downloaded ${name ?? 'release'}`, detail: null };
    case 'media_acquisition.upgrade.executed':
      return { message: `Upgraded ${name ?? 'release'}`, detail: null };
    case 'media_acquisition.download.failed':
      return {
        message: `Download failed${name ? ` for ${name}` : ''}`,
        detail: str(meta.error),
      };
    case 'automation.rule.executed': {
      const rule = str(meta.rule);
      return {
        message: `${failed ? 'Automation failed' : 'Automation'}${rule ? `: ${rule}` : ''}`,
        detail: failed ? (str(meta.error) ?? name) : name,
      };
    }
    default: {
      let message = genericMessage(row);
      if (name) message += `: ${name}`;
      return { message, detail: fromTo };
    }
  }
}

/** Generic "verb from action name" rendering used for un-specialized events. */
function genericMessage(row: AuditRow): string {
  // Bare verbs (e.g. "added", "deleted") only make sense with their objectType
  // prefixed; namespaced actions (e.g. "media.imdb.import.completed") already
  // carry their own context.
  const base =
    row.objectType && !row.action.includes('.')
      ? `${row.objectType} ${row.action}`
      : row.action;

  return base
    .replace(/[._]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word, i) => {
      const lower = word.toLowerCase();
      if (ACRONYMS[lower]) return ACRONYMS[lower];
      return i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    })
    .join(' ');
}

/** Fallback detail for a rename with no single from→to (multi-file / all skipped). */
function renameCounts(meta: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const key of ['applied', 'skipped', 'failed', 'deleted'] as const) {
    const n = meta[key];
    if (typeof n === 'number' && n > 0) parts.push(`${n} ${key}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

function asMeta(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object'
    ? (metadata as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function activityLevel(
  action: string,
  result: string,
): ActivityItem['level'] {
  if (result === 'failure' || /fail|error/i.test(action)) return 'error';
  if (/complet|created|added|approved|enabled|restore|import/i.test(action))
    return 'success';
  return 'info';
}

function activityName(meta: Record<string, unknown>): string | null {
  for (const key of ['name', 'title', 'releaseName', 'filename', 'path']) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('dashboard')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @RequirePermissions(PERMISSIONS.TORRENTS_VIEW)
  summary(@Query('engineId') engineId?: string) {
    return this.dashboard.summary(engineId);
  }

  @Get('activity')
  @RequirePermissions(PERMISSIONS.TORRENTS_VIEW)
  activity() {
    return this.dashboard.recentActivity();
  }
}

@Module({
  providers: [DashboardService],
  controllers: [DashboardController],
})
export class DashboardModule {}
