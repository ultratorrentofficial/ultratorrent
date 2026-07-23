import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import {
  NOTIFICATION_BUS_CHANNEL,
  NOTIFICATION_EVENTS,
  WS_EVENTS,
  type DuplicateScanEventPayload,
} from '@ultratorrent/shared';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { pageOf, parsePage } from '../../common/pagination';
import type { ListDuplicatesDto } from './dto/duplicates.dto';
import { recommend } from './duplicate-recommendation';
import type { JobReporter, JobSignal } from './media-processing-queue.service';

/**
 * Items pulled from the database per page.
 *
 * Detection is inherently whole-library — an item's duplicate can be anywhere — so
 * the set cannot be filtered down, only streamed. This bounds peak memory to a page
 * of hydrated rows rather than all of them at once.
 */
const ITEM_PAGE = 5_000;

/**
 * Groups whose writes go in one `$transaction` batch.
 *
 * The win here is round trips, not SQL: Prisma sends an array transaction as a
 * single batch, so 50 groups cost one round trip instead of ~250. Chunked rather
 * than done in one transaction because a single statement touching every item row
 * would hold locks across the whole table for the duration.
 */
const WRITE_BATCH = 50;

/**
 * Single-row key for the detection scan state. There is one detection domain (all
 * libraries at once), so the table holds exactly one row rather than inventing a
 * scope it does not have.
 */
const SCAN_STATE_ID = 'global';

/** A `notIn` list must not be empty; this id matches nothing. */
const NO_MATCH_ID = '00000000-0000-0000-0000-000000000000';

/** Split `xs` into consecutive slices of at most `size`. */
function chunked<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** A detected group with its members and the engine's verdict. */
interface ScoredGroup {
  group: DetectedGroup;
  members: DetectionItem[];
  rec: ReturnType<typeof recommend>;
}

/** Summary of one detection run — what the job records and the UI reports. */
export interface DetectionMetrics {
  itemsScanned: number;
  groupsDetected: number;
  groupsCreated: number;
  groupsUpdated: number;
  groupsRemoved: number;
  candidatesWritten: number;
  requiresReview: number;
  potentialSavingsBytes: number;
  durationMs: number;
  /** True when the input digest matched the last run and no writes were made. */
  unchanged: boolean;
}

/** Reasons two items are considered duplicates, in descending confidence. */
export type DuplicateReason =
  | 'external_id'
  | 'show_season_episode'
  | 'title_year'
  | 'similar_filename';

export interface DuplicateItemLike {
  id: string;
  mediaType: string;
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  /** Parent series tconst for a TV episode — the strongest show-identity signal. */
  seriesImdbId?: string | null;
  externalIds?: Array<{ provider: string; externalId: string }>;
  files?: Array<{
    resolution: string | null;
    videoCodec: string | null;
    size: bigint | number;
  }>;
}

/**
 * Exactly what detection and scoring read from an item — nothing else is selected.
 * Keeping this shape explicit is what stops the query drifting back to `include`,
 * which hydrated every column of every row for the sake of eight of them.
 */
interface DetectionItem {
  id: string;
  mediaType: string;
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  seriesImdbId: string | null;
  path: string;
  updatedAt: Date;
  externalIds: Array<{ provider: string; externalId: string }>;
  files: Array<{
    size: bigint;
    height: number | null;
    width: number | null;
    bitrateKbps: number | null;
    durationSec: number | null;
    audioChannels: number | null;
    resolution: string | null;
    videoCodec: string | null;
  }>;
}

/** Adapt a loaded item to the recommendation engine's input. */
function toRecommendationInput(i: DetectionItem) {
  return {
    id: i.id,
    title: i.title,
    year: i.year,
    season: i.season,
    episode: i.episode,
    path: i.path,
    modifiedAt: i.updatedAt,
    externalIds: i.externalIds.map((e) => ({ provider: e.provider, externalId: e.externalId })),
    file: i.files[0]
      ? {
          size: Number(i.files[0].size),
          height: i.files[0].height,
          width: i.files[0].width,
          bitrateKbps: i.files[0].bitrateKbps,
          durationSec: i.files[0].durationSec,
          audioChannels: i.files[0].audioChannels,
          resolution: i.files[0].resolution,
          videoCodec: i.files[0].videoCodec,
        }
      : null,
  };
}

/** Normalise a title for comparison: lowercase, strip punctuation/spacing. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/['`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The season/episode marker for an item: the structured `season`/`episode`
 * columns, else an `SxxEyy` parsed from the raw title (unidentified episodes keep
 * it in their filename). '' when neither is present. Pure — exported for testing.
 */
export function episodeMarker(item: DuplicateItemLike): string {
  if (item.season != null || item.episode != null) {
    return `:s${item.season ?? 'x'}:e${item.episode ?? 'x'}`;
  }
  const m = /\bs(\d{1,2})[ ._-]?e(\d{1,3})\b/i.exec(item.title);
  return m ? `:s${Number(m[1])}:e${Number(m[2])}` : '';
}

const RES_RANK: Record<string, number> = {
  '2160p': 5,
  '1080p': 4,
  '1080i': 3,
  '720p': 2,
  '480p': 1,
};
const CODEC_RANK: Record<string, number> = { AV1: 4, x265: 3, x264: 2, XviD: 1 };

/** A comparable quality score for an item from its best file. Pure. */
export function qualityScore(item: DuplicateItemLike): number {
  let best = 0;
  for (const f of item.files ?? []) {
    const res = f.resolution ? (RES_RANK[f.resolution] ?? 0) : 0;
    const codec = f.videoCodec ? (CODEC_RANK[f.videoCodec] ?? 0) : 0;
    const score = res * 10 + codec;
    if (score > best) best = score;
  }
  return best;
}

/**
 * Compute the grouping keys for an item across all duplicate strategies. Pure —
 * exported for unit testing. Each key is prefixed with its reason so keys from
 * different strategies never collide.
 */
export function duplicateKeys(item: DuplicateItemLike): Array<{
  reason: DuplicateReason;
  key: string;
}> {
  const keys: Array<{ reason: DuplicateReason; key: string }> = [];
  const normTitle = normalizeTitle(item.title);
  const isMovie = !item.mediaType || item.mediaType === 'movie';
  const epMarker = episodeMarker(item);
  const isEpisode = item.season != null && item.episode != null;

  // A TV episode belongs to a SHOW, and the first thing detection must establish is
  // that two episodes belong to the SAME show — otherwise S01E03 of one series and
  // S01E03 of an unrelated series that happens to share a name collapse into a false
  // "duplicate". Observed live: "Invasion (2005)" and "Invasion (2021)" both have an
  // S01E03, and grouped as one.
  //
  // The show is identified in priority order by its series id (`seriesImdbId`), else
  // by title + year. BOTH signals are emitted, so genuine duplicates group when
  // EITHER agrees (an identified copy still matches an unidentified-but-same-year
  // one, and a copy whose year is missing still matches on the series id), while two
  // different shows that merely share a title differ on BOTH and never collapse.
  const showScopes: string[] = [];
  if (item.seriesImdbId) showScopes.push(`sid:${item.seriesImdbId}`);
  showScopes.push(`ty:${normTitle}:${item.year ?? 'na'}`);

  // (c) external id — an entity-level signal, but NOT one to trust blindly:
  // contaminated metadata repeats a single id across genuinely different titles.
  // Observed live: "The Maze Runner" (2014), "Maze" (2017) and "The Runner" (2015)
  // all carried imdb tt1790864 / tmdb 198663, and grouped as one "duplicate".
  //
  // So the id is always SCOPED to keep a bad shared id from collapsing distinct
  // works, while two copies of the SAME work still match:
  //  - MOVIES are scoped by YEAR. Same id + same year still groups (external_id's
  //    real job — catching a film whose filenames parse to different titles), but
  //    different release years never collapse, the same guarantee `title_year` and
  //    `similar_filename` already give.
  //  - TV is scoped by SHOW IDENTITY + episode, since providers store a series-level
  //    id on every episode row (and some data repeats one id across *different*
  //    shows), so an unscoped id would merge a whole series — or two of them.
  for (const ext of item.externalIds ?? []) {
    if (isMovie) {
      keys.push({ reason: 'external_id', key: `external_id:${ext.provider}:${ext.externalId}:${item.year ?? 'na'}` });
    } else {
      for (const scope of showScopes) {
        keys.push({ reason: 'external_id', key: `external_id:${ext.provider}:${ext.externalId}:${scope}${epMarker}` });
      }
    }
  }

  // (b) show + season + episode — gated by show identity, not title alone.
  if (isEpisode) {
    for (const scope of showScopes) {
      keys.push({ reason: 'show_season_episode', key: `sse:${scope}:s${item.season}:e${item.episode}` });
    }
  }

  // (a) title + year (movies / shows without episode markers).
  if (!isEpisode) {
    keys.push({
      reason: 'title_year',
      key: `ty:${normTitle}:${item.year ?? 'na'}`,
    });
  }

  // (d) similar filename — a fallback signal, but it must stay as specific as the
  // primary keys: scoped to the SHOW + episode for shows, and to the YEAR for movies,
  // so different episodes of a series, different shows that share a title, AND
  // different films that share a title (Aladdin 1992 vs 2019) are never grouped.
  if (normTitle) {
    if (isEpisode) {
      for (const scope of showScopes) {
        keys.push({ reason: 'similar_filename', key: `fn:${scope}${epMarker}` });
      }
    } else {
      keys.push({ reason: 'similar_filename', key: `fn:${normTitle}:${item.year ?? 'na'}` });
    }
  }

  return keys;
}

const REASON_PRIORITY: Record<DuplicateReason, number> = {
  external_id: 0,
  show_season_episode: 1,
  title_year: 2,
  similar_filename: 3,
};

interface DetectedGroup {
  reason: DuplicateReason;
  itemIds: string[];
  /**
   * The bucket key that produced this group — a stable identity for the group across
   * scans. Detection previously deleted every group and recreated it, so ids changed
   * on every run and a human decision ("not a duplicate") had nothing durable to
   * attach to. Carrying the key out of the pure grouping step is what lets the
   * persistence layer upsert instead of delete-and-recreate.
   */
  key: string;
}

/**
 * Pure grouping: assign each item to at most one duplicate group, preferring
 * the highest-confidence reason. Exported for unit testing.
 */
export function detectDuplicateGroups(items: DuplicateItemLike[]): DetectedGroup[] {
  // Bucket items by every key they produce.
  const buckets = new Map<string, { reason: DuplicateReason; ids: string[] }>();
  for (const item of items) {
    for (const { reason, key } of duplicateKeys(item)) {
      const b = buckets.get(key) ?? { reason, ids: [] };
      b.ids.push(item.id);
      buckets.set(key, b);
    }
  }

  // Keep only buckets with >1 distinct item, ordered by reason priority. The key is
  // carried through so the group keeps one identity across scans.
  const candidates = [...buckets.entries()]
    .map(([key, b]) => ({ key, reason: b.reason, ids: [...new Set(b.ids)] }))
    .filter((b) => b.ids.length > 1)
    .sort(
      (a, b) =>
        REASON_PRIORITY[a.reason] - REASON_PRIORITY[b.reason] || a.key.localeCompare(b.key),
    );

  const assigned = new Set<string>();
  const groups: DetectedGroup[] = [];
  for (const cand of candidates) {
    const fresh = cand.ids.filter((id) => !assigned.has(id));
    if (fresh.length < 2) continue;
    for (const id of fresh) assigned.add(id);
    groups.push({ reason: cand.reason, itemIds: fresh, key: cand.key });
  }
  return groups;
}

/**
 * Detects duplicate MediaItems and persists them into MediaDuplicateGroup rows,
 * exposing a quality comparison so operators can pick the copy to keep.
 */
@Injectable()
export class MediaDuplicateService {
  private readonly logger = new Logger(MediaDuplicateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly eventBus: EventEmitter2,
  ) {}

  /**
   * Broadcast one scan lifecycle event.
   *
   * Scoped by the event NAME: the gateway derives its room from the prefix, and
   * `media_manager.*` maps to `media_manager.view`. Naming these `media.*` — as the
   * brief's literal list does — would have put library paths and file counts in the
   * room every authenticated user joins.
   */
  private emitScan(event: string, scanId: string, extra: Partial<DuplicateScanEventPayload> = {}): void {
    const payload: DuplicateScanEventPayload = {
      scanId,
      progress: 0,
      at: new Date().toISOString(),
      ...extra,
    };
    this.realtime.broadcast(event, payload);
  }

  /**
   * Emit a Notification Center domain event.
   *
   * Domain events only — this never sends a notification itself. Which rule fires,
   * to whom, over which channel, is the Notification Center's decision.
   *
   * Payload keys are chosen to match what `buildCard` renders (`mediaTitle`,
   * `libraryName`) plus raw fields a rule condition can filter on (`duplicateCount`,
   * `wastedBytes`, `confidence`, `reason`), so a rule can say "only when more than
   * 50 GB is reclaimable" without any code change.
   */
  private emitDomain(event: string, payload: Record<string, unknown>, dedupeKey?: string): void {
    this.eventBus.emit(NOTIFICATION_BUS_CHANNEL, {
      event,
      dedupeKey,
      payload,
      at: new Date().toISOString(),
    });
  }

  /**
   * Re-run duplicate detection across the whole library set.
   *
   * Runs as a background job rather than inside the HTTP request: measured on a
   * live 29,558-item library it took **10.5 s**, which is a spinner with no
   * feedback and, on a larger library, a gateway timeout. `report` streams
   * progress and `signal` lets the operator stop it.
   *
   * Returns metrics, not a page of results. Detection is a command and listing is
   * a query; returning page 1 meant a caller could not tell what the run did.
   */
  async detect(report?: JobReporter, signal?: JobSignal): Promise<DetectionMetrics> {
    const startedAt = Date.now();
    const scanId = randomUUID();
    this.emitScan(WS_EVENTS.MEDIA_DUPLICATE_SCAN_STARTED, scanId);

    // Every progress step goes to BOTH the job channel (which the page already
    // listens on) and the duplicate-specific channel, so a client can follow a scan
    // without knowing it is implemented as a MediaProcessingJob.
    const tick: JobReporter = async (progress, message) => {
      this.emitScan(WS_EVENTS.MEDIA_DUPLICATE_SCAN_PROGRESS, scanId, { progress, message });
      await report?.(progress, message);
    };

    try {
      return await this.runDetection(scanId, startedAt, tick, signal);
    } catch (err) {
      const cancelled = (err as Error)?.name === 'JobCancelledError';
      this.emitScan(
        cancelled ? WS_EVENTS.MEDIA_DUPLICATE_SCAN_CANCELLED : WS_EVENTS.MEDIA_DUPLICATE_SCAN_FAILED,
        scanId,
        { error: (err as Error).message },
      );
      throw err;
    }
  }

  private async runDetection(
    scanId: string,
    startedAt: number,
    report: JobReporter,
    signal?: JobSignal,
  ): Promise<DetectionMetrics> {
    await report?.(2, 'Checking for changes…');

    // The digest is taken BEFORE the items are loaded, and that order is
    // load-bearing. Stored digest = the state at T0; the rows actually processed =
    // the state at T1 ≥ T0. If something changed in between, the NEXT run computes a
    // digest that differs from the stored one and re-runs — over-inclusive, which is
    // the safe direction. Taking it after the load would store a digest newer than
    // the data processed, and the next run would skip a rescan that was needed.
    const digest = await this.inputDigest();
    if (await this.digestUnchanged(digest)) {
      await report?.(100, 'No media changed since the last scan.');
      const [itemCount, open, review] = await Promise.all([
        this.prisma.mediaItem.count(),
        this.prisma.mediaDuplicateGroup.count({ where: { status: 'open' } }),
        this.prisma.mediaDuplicateGroup.count({ where: { status: 'open', requiresReview: true } }),
      ]);
      this.logger.log(
        `Duplicate detection skipped: input unchanged (${open} open group(s)) in ${Date.now() - startedAt}ms`,
      );
      const unchangedMetrics: DetectionMetrics = {
        itemsScanned: itemCount,
        groupsDetected: open,
        groupsCreated: 0,
        groupsUpdated: 0,
        groupsRemoved: 0,
        candidatesWritten: 0,
        requiresReview: review,
        potentialSavingsBytes: 0,
        durationMs: Date.now() - startedAt,
        unchanged: true,
      };
      this.emitScan(WS_EVENTS.MEDIA_DUPLICATE_SCAN_COMPLETED, scanId, {
        progress: 100,
        metrics: unchangedMetrics,
      });
      // No domain event on an unchanged run. Nothing happened, and a notification
      // rule that fires every scheduled scan to say "still the same" is how an
      // operator learns to mute the channel.
      return unchangedMetrics;
    }

    signal?.throwIfCancelled();
    await report?.(5, 'Loading media items…');

    // Only the columns detection and scoring read, paged rather than loaded whole.
    // The previous `include` hydrated every column of ~29.5k items plus 63k
    // external-id rows and 29.5k file rows in one shot, most of it never read.
    const items: DetectionItem[] = [];
    for (let skip = 0; ; skip += ITEM_PAGE) {
      signal?.throwIfCancelled();
      const page = await this.prisma.mediaItem.findMany({
        skip,
        take: ITEM_PAGE,
        orderBy: { id: 'asc' },
        select: {
          id: true,
          mediaType: true,
          title: true,
          year: true,
          season: true,
          episode: true,
          seriesImdbId: true,
          path: true,
          updatedAt: true,
          externalIds: { select: { provider: true, externalId: true } },
          files: {
            select: {
              size: true,
              height: true,
              width: true,
              bitrateKbps: true,
              durationSec: true,
              audioChannels: true,
              resolution: true,
              videoCodec: true,
            },
          },
        },
      });
      items.push(...page);
      await report?.(Math.min(20, 5 + items.length / 2_000), `Loaded ${items.length} item(s)…`);
      if (page.length < ITEM_PAGE) break;
    }

    signal?.throwIfCancelled();
    await report?.(22, `Grouping ${items.length} item(s)…`);
    const groups = detectDuplicateGroups(items);

    const byId = new Map(items.map((i) => [i.id, i]));

    // Score every group up front — pure CPU, no I/O — so the write phase below is
    // nothing but batched database work.
    const scored = groups.map((group) => {
      const members = group.itemIds.map((id) => byId.get(id)!).filter(Boolean);
      return { group, members, rec: recommend(members.map(toRecommendationInput)) };
    });
    signal?.throwIfCancelled();

    // Detach every item first so an item that is no longer duplicated is released,
    // but DO NOT delete the groups: a group carries human decisions (ignored, with a
    // reason and an author; resolved, with a timestamp) and those must outlive a
    // rescan. This used to be `deleteMany({})` followed by `create()` per group,
    // which changed every group's id on every run — so "this is not a duplicate" was
    // impossible to persist, and an interrupted run stranded member-less rows.
    await this.prisma.mediaItem.updateMany({
      where: { duplicateGroupId: { not: null } },
      data: { duplicateGroupId: null },
    });

    // Resolve every existing group in ONE query per 1,000 keys rather than an
    // upsert per group.
    const existing = new Map<string, string>();
    for (const chunk of chunked(scored.map((s) => s.group.key), 1_000)) {
      const rows = await this.prisma.mediaDuplicateGroup.findMany({
        where: { groupKey: { in: chunk } },
        select: { id: true, groupKey: true },
      });
      for (const r of rows) if (r.groupKey) existing.set(r.groupKey, r.id);
    }

    // Ids are generated here so a bulk `createMany` can be used while the ids stay
    // known for the member and candidate writes that follow.
    const fresh = scored.filter((s) => !existing.has(s.group.key));
    for (const s of fresh) existing.set(s.group.key, randomUUID());
    for (const chunk of chunked(fresh, 500)) {
      await this.prisma.mediaDuplicateGroup.createMany({
        data: chunk.map((s) => ({
          id: existing.get(s.group.key)!,
          groupKey: s.group.key,
          reason: s.group.reason,
          groupType: 'file',
        })),
        skipDuplicates: true,
      });
    }

    let candidatesWritten = 0;
    let done = 0;
    for (const batch of chunked(scored, WRITE_BATCH)) {
      signal?.throwIfCancelled();
      const ops: Prisma.PrismaPromise<unknown>[] = [];
      for (const { group, members, rec } of batch) {
        const groupId = existing.get(group.key)!;
        ops.push(
          // `version` is bumped on every re-detection: a resolution previewed
          // against an older version is refused rather than applied to a membership
          // the operator never approved.
          this.prisma.mediaDuplicateGroup.update({
            where: { id: groupId },
            data: {
              reason: group.reason,
              version: { increment: 1 },
              confidence: rec.confidence,
              requiresReview: rec.requiresReview,
              potentialSavingsBytes: BigInt(rec.potentialSavingsBytes),
              recommendedItemId: rec.keepId,
              recommendation: { verdicts: rec.verdicts } as object,
              warnings: rec.warnings as unknown as object,
            },
          }),
          this.prisma.mediaItem.updateMany({
            where: { id: { in: group.itemIds } },
            data: { duplicateGroupId: groupId },
          }),
          // Candidate rows carry per-membership state (rank, why it lost) and
          // snapshot path/size, so a resolution stays auditable after the item row
          // is gone.
          this.prisma.mediaDuplicateCandidate.deleteMany({ where: { groupId } }),
          this.prisma.mediaDuplicateCandidate.createMany({
            data: rec.verdicts.map((v) => {
              const m = members.find((x) => x.id === v.id)!;
              return {
                groupId,
                itemId: v.id,
                path: m.path,
                fileSize: BigInt(m.files?.[0] ? Number(m.files[0].size) : 0),
                qualityScore: v.score,
                recommendationRank: v.rank,
                recommendationReasons: v.reasons as unknown as object,
              };
            }),
          }),
        );
        candidatesWritten += rec.verdicts.length;
      }
      // Prisma sends an array transaction as one batch, so a batch of 50 groups
      // costs one round trip instead of the ~200 the per-group loop spent.
      await this.prisma.$transaction(ops);
      done += batch.length;
      await report?.(30 + (done / Math.max(1, scored.length)) * 65, `Scored ${done}/${scored.length} group(s)…`);
    }

    // Groups detection no longer produces are dropped — UNLESS a human touched them.
    // An ignored group is retained precisely so the same false positive does not come
    // back; a resolved one is retained as history.
    const seen = [...existing.values()];
    const removed = await this.prisma.mediaDuplicateGroup.deleteMany({
      where: { id: { notIn: seen.length ? seen : [NO_MATCH_ID] }, status: 'open' },
    });

    await this.rememberDigest(digest);
    await report?.(100, `${scored.length} duplicate group(s).`);

    const metrics: DetectionMetrics = {
      itemsScanned: items.length,
      groupsDetected: scored.length,
      groupsCreated: fresh.length,
      groupsUpdated: scored.length - fresh.length,
      groupsRemoved: removed.count,
      candidatesWritten,
      requiresReview: scored.filter((s) => s.rec.requiresReview).length,
      potentialSavingsBytes: scored.reduce((n, s) => n + s.rec.potentialSavingsBytes, 0),
      durationMs: Date.now() - startedAt,
      unchanged: false,
    };
    this.logger.log(
      `Duplicate detection: ${metrics.itemsScanned} items → ${metrics.groupsDetected} groups ` +
        `(${metrics.groupsCreated} new, ${metrics.groupsRemoved} removed) in ${metrics.durationMs}ms`,
    );

    this.emitScan(WS_EVENTS.MEDIA_DUPLICATE_SCAN_COMPLETED, scanId, { progress: 100, metrics });
    this.announce(metrics, scored);
    return metrics;
  }

  /**
   * Domain events for a completed scan.
   *
   * `media.duplicate` was defined in the shared event catalog and seeded as an
   * ENABLED notification rule, but nothing in the backend ever emitted it — a rule
   * that could not fire, sitting in the UI looking configured. This is its producer.
   *
   * Emitted only when there is something to say: a run that found nothing sends
   * nothing, because a notification per scheduled scan is a notification an
   * operator turns off.
   */
  private announce(metrics: DetectionMetrics, scored: ScoredGroup[]): void {
    if (!metrics.groupsDetected) return;

    const base = {
      groupCount: metrics.groupsDetected,
      newGroups: metrics.groupsCreated,
      duplicateCount: metrics.candidatesWritten,
      wastedBytes: metrics.potentialSavingsBytes,
      requiresReview: metrics.requiresReview,
      reviewUrl: '/media/duplicates',
      scannedAt: new Date().toISOString(),
    };

    // Dedupe on the shape of the result, not the timestamp: a scheduled scan that
    // keeps finding the same 454 groups should notify once, not hourly.
    this.emitDomain(
      NOTIFICATION_EVENTS.MEDIA_DUPLICATE,
      {
        ...base,
        mediaTitle: `${metrics.groupsDetected} duplicate group(s)`,
        eventTime: base.scannedAt,
      },
      `duplicates:${metrics.groupsDetected}:${metrics.potentialSavingsBytes}`,
    );

    if (metrics.requiresReview > 0) {
      this.emitDomain(
        NOTIFICATION_EVENTS.MEDIA_DUPLICATE_REVIEW_REQUIRED,
        { ...base, mediaTitle: `${metrics.requiresReview} duplicate group(s) need review` },
        `duplicates-review:${metrics.requiresReview}`,
      );
    }

    // A single high-confidence group is worth naming, because it is actionable in
    // one click. The threshold matches the engine's own auto-safe bar.
    const best = scored
      .filter((s) => !s.rec.requiresReview && s.rec.keepId)
      .sort((a, b) => b.rec.potentialSavingsBytes - a.rec.potentialSavingsBytes)[0];
    if (best) {
      this.emitDomain(
        NOTIFICATION_EVENTS.MEDIA_DUPLICATE_DETECTED_EVENT,
        {
          mediaTitle: best.members[0]?.title ?? 'Duplicate media',
          groupReason: best.group.reason,
          confidence: best.rec.confidence,
          fileCount: best.members.length,
          wastedBytes: best.rec.potentialSavingsBytes,
          reviewUrl: '/media/duplicates',
        },
        `duplicate-top:${best.group.key}`,
      );
    }
  }

  /**
   * A non-destructive summary of the current duplicate state — the payload behind
   * the "Generate Duplicate Report" automation action.
   *
   * Reads stored group rows rather than re-running detection: a report is a
   * question about what is already known, and making it trigger a scan would let a
   * reporting rule quietly become a scanning schedule.
   */
  async report(libraryId?: string) {
    const where: Prisma.MediaDuplicateGroupWhereInput = { status: 'open' };
    if (libraryId) where.items = { some: { libraryId } };

    const [groups, totals] = await Promise.all([
      this.prisma.mediaDuplicateGroup.findMany({
        where,
        orderBy: [{ potentialSavingsBytes: 'desc' }],
        take: 100,
        select: {
          id: true,
          reason: true,
          confidence: true,
          requiresReview: true,
          potentialSavingsBytes: true,
          items: { select: { title: true, path: true }, take: 5 },
        },
      }),
      this.prisma.mediaDuplicateGroup.aggregate({
        where,
        _count: { _all: true },
        _sum: { potentialSavingsBytes: true },
      }),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      libraryId: libraryId ?? null,
      totalGroups: totals._count._all,
      totalReclaimableBytes: Number(totals._sum.potentialSavingsBytes ?? 0),
      needsReview: groups.filter((g) => g.requiresReview).length,
      // Capped: a report is something a human or a webhook reads, and an
      // unbounded one is neither.
      truncated: totals._count._all > groups.length,
      groups: groups.map((g) => ({
        id: g.id,
        title: g.items[0]?.title ?? null,
        reason: g.reason,
        confidence: g.confidence,
        requiresReview: g.requiresReview,
        reclaimableBytes: Number(g.potentialSavingsBytes),
        fileCount: g.items.length,
        paths: g.items.map((i) => i.path),
      })),
    };
  }

  /**
   * A digest of everything detection reads, computed in the database.
   *
   * Covers identity, path, total file size and external ids — the inputs that can
   * change which groups exist. A metadata refresh that rewrites an unrelated column
   * should not force thousands of writes to reproduce a result that cannot have
   * moved.
   *
   * Done in SQL rather than over loaded rows because the loading was the expensive
   * part: hydrating 29,558 items to hash them cost 2,635 ms, the same digest as one
   * query costs ~665 ms, and this way the unchanged case never loads them at all.
   *
   * `md5` because it is a Postgres builtin while `sha256` needs `pgcrypto`. This is
   * change detection, not security — a collision means a rescan is skipped, not
   * that anything is deleted.
   */
  private async inputDigest(): Promise<string> {
    const rows = await this.prisma.$queryRaw<Array<{ digest: string }>>`
      SELECT coalesce(md5(string_agg(x, E'\n' ORDER BY x)), 'empty') AS digest
      FROM (
        SELECT i.id || '|' || i."mediaType" || '|' || i.title || '|' ||
               coalesce(i.year::text, '') || '|' ||
               coalesce(i.season::text, '') || '|' ||
               coalesce(i.episode::text, '') || '|' || i.path || '|' ||
               -- SUM, not the first file's size: any file changing size has to move
               -- the digest, and an item is not guaranteed to have exactly one.
               coalesce((SELECT sum(f.size) FROM media_files f WHERE f."itemId" = i.id)::text, '0') || '|' ||
               coalesce((SELECT string_agg(e.provider || ':' || e."externalId", ','
                                           ORDER BY e.provider, e."externalId")
                         FROM media_external_ids e WHERE e."itemId" = i.id), '') AS x
        FROM media_items i
      ) t
    `;
    return rows[0]?.digest ?? 'empty';
  }

  /** True when the last run that wrote anything saw exactly this input. */
  private async digestUnchanged(digest: string): Promise<boolean> {
    const row = await this.prisma.mediaDuplicateScanState.findUnique({
      where: { id: SCAN_STATE_ID },
    });
    return row?.inputDigest === digest;
  }

  private async rememberDigest(digest: string): Promise<void> {
    await this.prisma.mediaDuplicateScanState.upsert({
      where: { id: SCAN_STATE_ID },
      create: { id: SCAN_STATE_ID, inputDigest: digest },
      update: { inputDigest: digest, updatedAt: new Date() },
    });
  }

  /** List current duplicate groups (paginated) with a per-item quality comparison. */
  async list(page?: string, pageSize?: string, query: ListDuplicatesDto = {}) {
    const params = parsePage(page ?? query.page, pageSize ?? query.pageSize, 25);
    const where = this.groupWhere(query);
    const [total, groups] = await Promise.all([
      this.prisma.mediaDuplicateGroup.count({ where }),
      this.prisma.mediaDuplicateGroup.findMany({
        where,
        include: { items: { include: { files: true, externalIds: true } } },
        orderBy: this.groupOrder(query.sort),
        skip: params.skip,
        take: params.take,
      }),
    ]);

    const items = groups.map((g) => {
      const scored = g.items.map((item) => {
        const score = qualityScore({
          id: item.id,
          mediaType: item.mediaType,
          title: item.title,
          year: item.year,
          season: item.season,
          episode: item.episode,
          files: item.files,
        });
        const totalSize = item.files.reduce(
          (acc, f) => acc + Number(f.size),
          0,
        );
        return {
          id: item.id,
          title: item.title,
          year: item.year,
          season: item.season,
          episode: item.episode,
          libraryId: item.libraryId,
          path: item.path,
          qualityScore: score,
          totalSize,
          bestResolution: item.files
            .map((f) => f.resolution)
            .filter(Boolean)[0] ?? null,
          bestCodec: item.files.map((f) => f.videoCodec).filter(Boolean)[0] ?? null,
        };
      });
      // Highest quality first; the top row is the suggested "keep".
      scored.sort((a, b) => b.qualityScore - a.qualityScore || b.totalSize - a.totalSize);
      return {
        id: g.id,
        reason: g.reason,
        groupType: g.groupType,
        status: g.status,
        confidence: g.confidence,
        requiresReview: g.requiresReview,
        potentialSavingsBytes: Number(g.potentialSavingsBytes),
        version: g.version,
        ignoredReason: g.ignoredReason,
        createdAt: g.createdAt,
        suggestedKeepId: scored[0]?.id ?? null,
        items: scored,
      };
    });

    // Applied after the page is fetched because neither is a column: `files_desc`
    // counts a relation and `title` lives on the member items. Both therefore order
    // WITHIN the page, which is honest for a page-at-a-time list and keeps
    // pagination stable; the column orderings above cover the rest.
    if (query.sort === 'files_desc') items.sort((a, b) => b.items.length - a.items.length);
    if (query.sort === 'title') {
      items.sort((a, b) => (a.items[0]?.title ?? '').localeCompare(b.items[0]?.title ?? ''));
    }
    return pageOf(items, total, params);
  }

  // --- Duplicate Center -----------------------------------------------------

  /**
   * Counts for the Duplicate Center landing screen.
   *
   * Every figure is a single aggregate rather than a page of rows loaded and counted
   * in JS — the old list path pulled whole groups with their items, files and
   * external ids just to render a table, which does not survive a library of tens of
   * thousands of files.
   */
  async overview() {
    const [byStatus, byType, byReason, review, savings, lastGroup, resolutions] =
      await Promise.all([
        this.prisma.mediaDuplicateGroup.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.mediaDuplicateGroup.groupBy({ by: ['groupType'], _count: { _all: true } }),
        this.prisma.mediaDuplicateGroup.groupBy({ by: ['reason'], _count: { _all: true } }),
        this.prisma.mediaDuplicateGroup.count({ where: { status: 'open', requiresReview: true } }),
        this.prisma.mediaDuplicateGroup.aggregate({
          where: { status: 'open' },
          _sum: { potentialSavingsBytes: true },
        }),
        this.prisma.mediaDuplicateGroup.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
        this.prisma.mediaDuplicateResolution.groupBy({ by: ['status'], _count: { _all: true } }),
      ]);

    const count = (rows: Array<{ _count: { _all: number } }>, key: string, field: string) =>
      rows.find((r) => (r as unknown as Record<string, unknown>)[field] === key)?._count._all ?? 0;

    return {
      groups: {
        total: byStatus.reduce((a, r) => a + r._count._all, 0),
        open: count(byStatus, 'open', 'status'),
        ignored: count(byStatus, 'ignored', 'status'),
        resolved: count(byStatus, 'resolved', 'status'),
      },
      needsReview: review,
      byType: {
        file: count(byType, 'file', 'groupType'),
        showFolder: count(byType, 'show_folder', 'groupType'),
      },
      byReason: Object.fromEntries(byReason.map((r) => [r.reason, r._count._all])),
      // Potential reclaim is only meaningful once candidates carry sizes, which the
      // recommendation engine fills in. Reported as 0 rather than guessed.
      potentialSavingsBytes: Number(savings._sum.potentialSavingsBytes ?? 0),
      lastDetectedAt: lastGroup?.createdAt ?? null,
      resolutions: Object.fromEntries(resolutions.map((r) => [r.status, r._count._all])),
    };
  }

  /** Build the Prisma filter for a Duplicate Center query. */
  private groupWhere(query: ListDuplicatesDto): Prisma.MediaDuplicateGroupWhereInput {
    const where: Prisma.MediaDuplicateGroupWhereInput = {};
    // Default to OPEN. A landing screen that silently includes resolved and ignored
    // groups is how an operator loses faith in the counts.
    where.status = query.status ?? 'open';
    if (query.groupType) where.groupType = query.groupType;
    if (query.reason) where.reason = query.reason;
    if (query.requiresReview === 'true') where.requiresReview = true;

    // Item-level filters reach through the membership, so a library or media-type
    // filter means "this group has a member there" rather than dropping the group.
    const item: Prisma.MediaItemWhereInput = {};
    if (query.libraryId) item.libraryId = query.libraryId;
    if (query.mediaType) item.mediaType = query.mediaType;
    const q = query.q?.trim();
    if (q) {
      item.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { path: { contains: q, mode: 'insensitive' } },
      ];
    }
    if (Object.keys(item).length) where.items = { some: item };
    return where;
  }

  /** Translate a sort token into a Prisma ordering. */
  private groupOrder(sort?: string): Prisma.MediaDuplicateGroupOrderByWithRelationInput[] {
    switch (sort) {
      case 'savings_desc':
        return [{ potentialSavingsBytes: 'desc' }, { createdAt: 'desc' }];
      case 'confidence_desc':
        return [{ confidence: 'desc' }, { createdAt: 'desc' }];
      case 'confidence_asc':
        return [{ confidence: 'asc' }, { createdAt: 'desc' }];
      case 'recent':
        return [{ createdAt: 'desc' }];
      case 'oldest':
        return [{ createdAt: 'asc' }];
      case 'files_desc':
      case 'title':
        // Neither is expressible as a column ordering (one counts a relation, the
        // other lives on the member items). Sorted in the handler; the stable
        // createdAt ordering keeps pagination deterministic underneath.
        return [{ createdAt: 'desc' }];
      case 'needs_review':
      default:
        // The default view: what needs a decision, biggest reclaim first.
        return [{ requiresReview: 'desc' }, { potentialSavingsBytes: 'desc' }, { createdAt: 'desc' }];
    }
  }

  /** One group with everything the comparison view needs. */
  async get(groupId: string) {
    const g = await this.prisma.mediaDuplicateGroup.findUnique({
      where: { id: groupId },
      include: { items: { include: { files: true, externalIds: true, library: { select: { id: true, name: true } } } } },
    });
    if (!g) throw new NotFoundException('Duplicate group not found');

    const candidates = g.items.map((item) => {
      const f = item.files[0];
      return {
        id: item.id,
        title: item.title,
        year: item.year,
        season: item.season,
        episode: item.episode,
        mediaType: item.mediaType,
        matchStatus: item.matchStatus,
        libraryId: item.libraryId,
        libraryName: item.library?.name ?? null,
        path: item.path,
        addedAt: item.createdAt,
        modifiedAt: item.updatedAt,
        externalIds: item.externalIds.map((e) => ({ provider: e.provider, externalId: e.externalId })),
        totalSize: item.files.reduce((acc, x) => acc + Number(x.size), 0),
        qualityScore: qualityScore({
          id: item.id,
          mediaType: item.mediaType,
          title: item.title,
          year: item.year,
          season: item.season,
          episode: item.episode,
          files: item.files,
        }),
        // Split deliberately. The parsed fields come from the FILENAME and are mostly
        // null on a renamed library (measured: 96% of files had no videoCodec, 100%
        // no hdr) because the renamer strips those tokens. Presenting them beside
        // measured values as if equally trustworthy is how a comparison view ends up
        // full of blanks that look like missing data rather than absent evidence.
        parsed: {
          container: f?.container ?? null,
          resolution: f?.resolution ?? null,
          videoCodec: f?.videoCodec ?? null,
          audioCodec: f?.audioCodec ?? null,
          hdr: f?.hdr ?? null,
          releaseGroup: f?.releaseGroup ?? null,
          quality: f?.quality ?? null,
          language: f?.language ?? null,
        },
        measured: {
          width: f?.width ?? null,
          height: f?.height ?? null,
          bitrateKbps: f?.bitrateKbps ?? null,
          durationSec: f?.durationSec ?? null,
          audioChannels: f?.audioChannels ?? null,
          frameRate: f?.frameRate ?? null,
        },
      };
    });
    candidates.sort((a, b) => b.qualityScore - a.qualityScore || b.totalSize - a.totalSize);

    return {
      id: g.id,
      groupKey: g.groupKey,
      groupType: g.groupType,
      reason: g.reason,
      status: g.status,
      confidence: g.confidence,
      requiresReview: g.requiresReview,
      version: g.version,
      potentialSavingsBytes: Number(g.potentialSavingsBytes),
      recommendedItemId: g.recommendedItemId,
      recommendation: g.recommendation,
      warnings: g.warnings,
      ignoredReason: g.ignoredReason,
      ignoredAt: g.ignoredAt,
      resolvedAt: g.resolvedAt,
      createdAt: g.createdAt,
      // Until the recommendation engine lands, the suggestion is the top-scored
      // candidate — the same rule the old page used, surfaced honestly as a
      // suggestion rather than dressed up as a recommendation with reasons.
      suggestedKeepId: candidates[0]?.id ?? null,
      candidates,
    };
  }

  /**
   * Mark a group "not a duplicate". Survives rescans by design: detection only
   * deletes groups whose status is still `open`.
   */
  async ignore(groupId: string, reason: string | undefined, userId?: string) {
    await this.getOrThrow(groupId);
    return this.prisma.mediaDuplicateGroup.update({
      where: { id: groupId },
      data: {
        status: 'ignored',
        ignoredReason: reason?.trim() || null,
        ignoredById: userId ?? null,
        ignoredAt: new Date(),
      },
    });
  }

  /** Put an ignored or resolved group back in front of the operator. */
  async reopen(groupId: string) {
    await this.getOrThrow(groupId);
    return this.prisma.mediaDuplicateGroup.update({
      where: { id: groupId },
      data: {
        status: 'open',
        ignoredReason: null,
        ignoredById: null,
        ignoredAt: null,
        resolvedById: null,
        resolvedAt: null,
      },
    });
  }

  private async getOrThrow(groupId: string) {
    const g = await this.prisma.mediaDuplicateGroup.findUnique({ where: { id: groupId } });
    if (!g) throw new NotFoundException('Duplicate group not found');
    return g;
  }
}
