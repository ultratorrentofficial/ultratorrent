import { Controller, Get, Injectable, Query, UseGuards } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, TorrentState } from '@ultratorrent/shared';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { TransferLedgerService } from '../transfer-ledger/transfer-ledger.service';

@Injectable()
export class DashboardService {
  constructor(
    private readonly registry: EngineRegistryService,
    private readonly prisma: PrismaService,
    private readonly ledger: TransferLedgerService,
  ) {}

  async summary(engineId?: string) {
    const provider = await this.registry.resolve(engineId).catch(() => null);
    const [torrents, stats, totals] = provider
      ? await Promise.all([
          provider.listTorrents().catch(() => []),
          provider.getGlobalStats().catch(() => null),
          this.ledger.totals(provider.engineId),
        ])
      : [[], null, await this.ledger.totals(engineId)];

    const byState = (s: TorrentState) =>
      torrents.filter((t) => t.state === s).length;

    /*
     * Lifetime totals come from the ledger, not from the torrents in front of
     * us. Summing the live list — which is what this did — answers "how much
     * have the survivors transferred", and every removal quietly shrinks the
     * answer. On a live install that read 41 GiB against 886 GiB of real
     * history.
     *
     * Note these survive an offline engine: the ledger is in Postgres, so a
     * dashboard loaded while qBittorrent is down still reports the true totals
     * instead of zeroing them.
     */
    const totalUploaded = Number(totals.uploaded);
    const totalDownloaded = Number(totals.downloaded);

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
      ratio: totals.ratio,
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
      include: { user: { select: { username: true, displayName: true } } },
    });
    return collapseActivity(rows, limit, await this.mediaNames(rows));
  }

  /**
   * Names for the media behind the feed's rows. The enrichment sweeps record
   * only their own particulars ({@code {provider: 'tmdb'}}) — never a title —
   * so the subject has to come from the `media_item` each row already points
   * at. Resolving by id rather than by metadata also names the rows already
   * written, instead of only those recorded from here on.
   */
  private async mediaNames(rows: AuditRow[]): Promise<MediaNames> {
    const ids = [
      ...new Set(
        rows
          .filter((r) => r.objectType === 'media_item' && r.objectId)
          .map((r) => r.objectId as string),
      ),
    ];
    if (!ids.length) return new Map();
    const items = await this.prisma.mediaItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true, year: true, season: true, episode: true },
    });
    return new Map(items.map((i) => [i.id, mediaDisplayName(i)]));
  }
}

/** Media titles by `media_item` id, for rows whose metadata carries no name. */
export type MediaNames = Map<string, string>;

/** How a media item is named in the feed: "Show S02E07" / "Film (2024)". */
function mediaDisplayName(item: {
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
}): string {
  if (item.season !== null && item.episode !== null) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${item.title} S${pad(item.season)}E${pad(item.episode)}`;
  }
  return item.year ? `${item.title} (${item.year})` : item.title;
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
  /**
   * The individual events behind a collapsed line, each rendered as it would
   * have been on its own. A summary that cannot be opened asks the reader to
   * take "24 events" on faith; null for a line that is already a single event.
   */
  events: ActivityItem[] | null;
}

export type AuditRow = {
  id: string;
  action: string;
  objectType: string | null;
  objectId?: string | null;
  result: string;
  metadata: unknown;
  createdAt: Date;
  user: { username: string; displayName?: string | null } | null;
};

/**
 * How an actor is named in the feed: their full name, falling back to the login
 * handle for an account that never set one. The feed is read by people, and a
 * person is recognised by their name, not by their handle.
 */
function actorName(row: AuditRow): string | null {
  return row.user?.displayName || row.user?.username || null;
}

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

export function toActivityItem(row: AuditRow, names: MediaNames = new Map()): ActivityItem {
  const meta = asMeta(row.metadata);
  const described = describeActivity(row, meta, resolvedName(row, names));
  let message = described.message;
  const actor = actorName(row);
  if (actor) message += ` · ${actor}`;

  return {
    id: row.id,
    type: row.action,
    message,
    detail: described.detail,
    level: activityLevel(row.action, row.result),
    at: row.createdAt.toISOString(),
    events: null,
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
export function collapseActivity(
  rows: AuditRow[],
  limit: number,
  names: MediaNames = new Map(),
): ActivityItem[] {
  // Whole groups, not just counts: a collapsed line names the media it covers,
  // which needs every row in the group, not only its representative.
  const groups = new Map<string, AuditRow[]>();
  for (const r of rows) {
    if (NEVER_COLLAPSE.has(r.action)) continue;
    const key = burstSignature(r);
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }

  const out: ActivityItem[] = [];
  const emitted = new Set<string>();
  for (const r of rows) {
    const key = burstSignature(r);
    const group = NEVER_COLLAPSE.has(r.action) ? undefined : groups.get(key);
    if (group && group.length >= 2) {
      if (emitted.has(key)) continue; // group already represented
      emitted.add(key);
      out.push(burstActivityItem(r, group, names));
    } else {
      out.push(toActivityItem(r, names));
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** A single collapsed line for a burst: a label naming its media, and a count. */
function burstActivityItem(rep: AuditRow, group: AuditRow[], names: MediaNames): ActivityItem {
  return {
    id: rep.id,
    type: rep.action,
    message: burstLabel(rep, group, names),
    detail: `${group.length} events`,
    level: activityLevel(rep.action, rep.result),
    at: rep.createdAt.toISOString(),
    events: group.map((r) => toActivityItem(r, names)),
  };
}

/**
 * How many of a burst's subjects are named before the rest become "+N more".
 * Two keeps the line scannable while still answering "what did it touch?".
 */
const BURST_NAMES_SHOWN = 2;

/**
 * The collapsed-line label: the verb, the media it covered, and the actor. A
 * sweep that reports only its verb ("Media artwork import") tells an operator
 * nothing they can act on — the subject is the whole point of the line.
 */
function burstLabel(rep: AuditRow, group: AuditRow[], names: MediaNames): string {
  let label: string;
  if (rep.action === 'automation.rule.executed') {
    const rule = str(asMeta(rep.metadata).rule);
    const base = rep.result === 'failure' ? 'Automation failed' : 'Automation';
    label = rule ? `${base}: ${rule}` : base;
  } else {
    label = actionLabel(rep);
    const subjects = burstSubjects(group, names);
    if (subjects) label += `: ${subjects}`;
  }
  const actor = actorName(rep);
  if (actor) label += ` · ${actor}`;
  return label;
}

/** The distinct media in a burst: the first few by name, then a "+N more" tail. */
function burstSubjects(group: AuditRow[], names: MediaNames): string | null {
  const distinct: string[] = [];
  for (const r of group) {
    const name = activityName(asMeta(r.metadata), resolvedName(r, names));
    if (name && !distinct.includes(name)) distinct.push(name);
  }
  if (!distinct.length) return null;
  const shown = distinct.slice(0, BURST_NAMES_SHOWN).join(', ');
  const rest = distinct.length - BURST_NAMES_SHOWN;
  return rest > 0 ? `${shown} +${rest} more` : shown;
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
  resolved: string | null = null,
): { message: string; detail: string | null } {
  const name = activityName(meta, resolved);
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
    case 'media_acquisition.missing_episode.grabbed':
      return {
        message: `Grabbed missing episode${name ? `: ${name}` : ''}`,
        // How it was found matters when a grab surprises someone — a rule match
        // and a manual search are different stories.
        detail: str(meta.via) ? `via ${str(meta.via)}` : null,
      };
    case 'media_acquisition.evaluation.created': {
      const decision = str(meta.decision);
      return {
        message: `Evaluated ${name ?? 'release'}${decision ? ` — ${decision}` : ''}`,
        detail: str(meta.reason),
      };
    }
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
      let message = actionLabel(row);
      if (name) message += `: ${name}`;
      return { message, detail: fromTo };
    }
  }
}

/**
 * Plain-language labels for the background sweeps. Each writes one audit row per
 * media item, so they reach the feed as collapsed lines; "Media NFO generate"
 * is the machine's name for the job, not a description of what happened.
 */
const ACTION_LABELS: Record<string, string> = {
  'media.artwork.import': 'Imported artwork',
  'media.metadata.fetch': 'Fetched metadata',
  'media.imdb.enrichment.completed': 'Enriched from IMDb',
  'media.nfo.generate': 'Wrote NFO',
};

/** A readable verb for an action: a curated label, else derived from its name. */
function actionLabel(row: AuditRow): string {
  const label = ACTION_LABELS[row.action];
  if (label) return label;
  if (row.action === 'media.integration.refresh') {
    const kind = str(asMeta(row.metadata).kind);
    // "plex" is the stored value; it is a product name to the person reading.
    if (kind) return `Refreshed ${kind.charAt(0).toUpperCase() + kind.slice(1)}`;
    return 'Refreshed integration';
  }
  return genericMessage(row);
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
  for (const key of ['applied', 'skipped', 'failed', 'duplicates', 'deleted'] as const) {
    const n = meta[key];
    if (typeof n === 'number' && n > 0) {
      // "3 duplicates" reads as a count of things; the rest read as outcomes.
      parts.push(key === 'duplicates' ? `${n} as duplicate${n === 1 ? '' : 's'}` : `${n} ${key}`);
    }
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

function activityName(
  meta: Record<string, unknown>,
  resolved: string | null = null,
): string | null {
  /*
   * `releaseTitle` was missing from this list, so a missing-episode grab —
   * which records exactly that field — rendered as a bare verb with no subject:
   * "Media acquisition missing episode grabbed", and nothing about what.
   */
  for (const key of ['name', 'title', 'releaseName', 'releaseTitle']) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  // A resolved title beats a filename or a full path: "Beyond the Gates S02E122"
  // is the same fact as ".../Beyond the Gates - S02E122 - Episode 122.nfo", said
  // in the form a person reads.
  if (resolved) return resolved;
  for (const key of ['filename', 'path']) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** The media title behind a row, when it points at a `media_item`. */
function resolvedName(row: AuditRow, names: MediaNames): string | null {
  return (row.objectId && names.get(row.objectId)) || null;
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
