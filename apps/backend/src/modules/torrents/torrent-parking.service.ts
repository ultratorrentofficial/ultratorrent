import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { NormalizedTorrent, TorrentState } from '@ultratorrent/shared';
import type { TorrentEngineProvider } from '../../domain/engine/torrent-engine-provider.interface';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SettingsService } from '../settings/settings.module';

const SETTINGS_KEY = 'torrents.parking';
const TICK_MS = 5 * 60_000;

export interface ParkingRules {
  /** Ships OFF. Parking pauses torrents, so an operator opts in. */
  enabled: boolean;
  /** Fewer tracker-reported seeders than this and the swarm counts as dead. */
  minSeeders: number;
  /** Grace period after a torrent is added, before it may be judged dead. */
  deadAfterMinutes: number;
  /**
   * Park a torrent that has moved **nothing** for this long with no seed connected,
   * *even if its tracker claims seeders exist*. Trackers lie: on synoplex 66 of the
   * 100 active slots were held by torrents whose tracker reported a seeder while
   * they sat at 0 bytes for 24 hours — the seeder-count rule alone can never free
   * those. 0 disables the rule.
   */
  stalledAfterMinutes: number;
  /** Parked torrents force-started per tick to refresh their seeder count. */
  probeBatchSize: number;
  /** Minimum gap before re-probing a torrent that is still dead. */
  probeIntervalMinutes: number;
  /** Cap on the exponential backoff between probes of a persistently dead torrent. */
  maxProbeIntervalMinutes: number;
}

export const DEFAULT_PARKING_RULES: ParkingRules = {
  enabled: false,
  minSeeders: 1,
  deadAfterMinutes: 30,
  stalledAfterMinutes: 180,
  probeBatchSize: 20,
  probeIntervalMinutes: 60,
  maxProbeIntervalMinutes: 1440,
};

export interface ParkingTickSummary {
  parked: number;
  revived: number;
  probed: number;
  stillDead: number;
}

/**
 * Keeps dead torrents out of the engine's active-download queue.
 *
 * The problem it solves: an engine has a limited number of active-download slots
 * (qBittorrent's `max_active_downloads`, 100 by default here). A magnet with no
 * seeders can never even fetch its metadata, yet it *occupies a slot the whole
 * time it tries*. Grab enough dead releases and every slot fills with torrents
 * that will never finish — and every healthy torrent behind them sits in
 * `queuedDL` forever. Observed in production: 100 slots held by dead magnets,
 * 1,034 torrents queued behind them, 0 bytes moving.
 *
 * So: a torrent that is active, making no progress, connected to nobody, and
 * whose tracker reports no seeders (after a grace period) gets **paused** and
 * recorded here. A paused torrent holds no slot, so the engine promotes a queued
 * torrent into the freed slot — which is then judged on its own merits next tick.
 * The queue drains itself of dead weight and the live torrents get to run.
 *
 * Getting them back: a paused torrent doesn't announce, so its seeder count can
 * never refresh on its own — parking would be a one-way trip. Each tick therefore
 * **force-starts** a small batch of parked torrents (force-start bypasses the
 * queue limits, so a probe can't be starved by a full queue). They announce; the
 * next tick reads the result. Seeders found → released back into the normal queue.
 * Still dead → paused again, with an exponential backoff so a long-dead torrent is
 * retried rarely rather than every cycle. A released torrent that dies again is
 * simply re-parked by the normal path.
 */
@Injectable()
export class TorrentParkingService {
  private readonly logger = new Logger(TorrentParkingService.name);
  /** Claimed synchronously so a slow tick can't overlap the next one. */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EngineRegistryService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async getRules(): Promise<ParkingRules> {
    const stored = await this.settings.get<Partial<ParkingRules>>(SETTINGS_KEY);
    return { ...DEFAULT_PARKING_RULES, ...(stored ?? {}) };
  }

  async setRules(patch: Partial<ParkingRules>, userId?: string): Promise<ParkingRules> {
    const next: ParkingRules = { ...(await this.getRules()), ...patch };
    next.minSeeders = Math.max(0, Math.trunc(next.minSeeders));
    next.deadAfterMinutes = Math.max(1, Math.trunc(next.deadAfterMinutes));
    next.stalledAfterMinutes = Math.max(0, Math.trunc(next.stalledAfterMinutes)); // 0 = rule off
    next.probeBatchSize = Math.max(1, Math.trunc(next.probeBatchSize));
    next.probeIntervalMinutes = Math.max(1, Math.trunc(next.probeIntervalMinutes));
    next.maxProbeIntervalMinutes = Math.max(next.probeIntervalMinutes, Math.trunc(next.maxProbeIntervalMinutes));
    await this.settings.set(SETTINGS_KEY, next);
    await this.audit
      .record({ userId, action: 'torrents.parking.updated', objectType: 'settings', objectId: SETTINGS_KEY })
      .catch(() => undefined);
    return next;
  }

  /** Everything currently held out of the queue. */
  listParked(engineId?: string) {
    return this.prisma.parkedTorrent.findMany({
      where: engineId ? { engineId } : undefined,
      orderBy: { parkedAt: 'desc' },
    });
  }

  @Interval('torrent_parking_sweep', TICK_MS)
  async tick(): Promise<ParkingTickSummary> {
    const empty: ParkingTickSummary = { parked: 0, revived: 0, probed: 0, stillDead: 0 };
    if (this.running) return empty;
    this.running = true;
    try {
      const rules = await this.getRules();
      if (!rules.enabled) return empty;
      return await this.run(rules);
    } catch (err) {
      this.logger.warn(`Parking sweep failed: ${(err as Error).message}`);
      return empty;
    } finally {
      this.running = false;
    }
  }

  /** Run one pass immediately, ignoring only the schedule (not the enabled flag). */
  async runNow(userId?: string): Promise<ParkingTickSummary> {
    const rules = await this.getRules();
    if (!rules.enabled) return { parked: 0, revived: 0, probed: 0, stillDead: 0 };
    await this.audit
      .record({ userId, action: 'torrents.parking.run', objectType: 'settings', objectId: SETTINGS_KEY })
      .catch(() => undefined);
    return this.run(rules);
  }

  private async run(rules: ParkingRules): Promise<ParkingTickSummary> {
    const total: ParkingTickSummary = { parked: 0, revived: 0, probed: 0, stillDead: 0 };
    for (const provider of this.registry.list()) {
      let torrents: NormalizedTorrent[];
      try {
        torrents = await provider.listTorrents();
      } catch (err) {
        // One unreachable engine must not stop the others.
        this.logger.warn(`Parking: engine ${provider.engineId} unreachable: ${(err as Error).message}`);
        continue;
      }
      const byHash = new Map(torrents.map((t) => [t.hash.toLowerCase(), t]));

      // Order matters: judge the probes started last tick BEFORE parking or
      // starting new ones, or a probe in flight would be re-parked as "dead"
      // while it is still announcing.
      const judged = await this.judgeProbes(provider, byHash, rules);
      total.revived += judged.revived;
      total.stillDead += judged.stillDead;
      total.parked += await this.parkDead(provider, torrents, rules);
      total.probed += await this.startProbes(provider, byHash, rules);
    }
    if (total.parked || total.revived) {
      this.logger.log(
        `Parking sweep: ${total.parked} parked, ${total.revived} revived, ${total.probed} probing, ${total.stillDead} still dead`,
      );
      this.realtime.broadcast('torrents.parking.updated', total);
    }
    return total;
  }

  /**
   * Why this torrent should be pulled out of the active queue, or null to leave it.
   *
   * Only `DOWNLOADING` is judged (qBittorrent maps `metaDL`/`stalledDL` to it) —
   * those are the states that consume an active slot. A QUEUED torrent isn't
   * costing anything and hasn't announced recently enough to be judged fairly, and
   * a PAUSED one was paused by someone; leave both alone.
   *
   * Two ways to be dead:
   *
   * - `no_seeders` — nobody connected and the tracker knows of no seeders. Quick to
   *   call (a short grace period), because there is nothing to wait for.
   * - `stalled` — moving no bytes at all with no seed connected, for hours, **even
   *   though the tracker claims seeders exist**. This second rule is not redundant:
   *   trackers report stale counts, and on synoplex 66 of the 100 active slots were
   *   held by torrents whose tracker advertised a seeder while they sat at zero
   *   bytes for 24 hours. Judged only on hard evidence — zero throughput and zero
   *   connected seeds — so a torrent that is merely slow is never touched.
   */
  deadReason(t: NormalizedTorrent, rules: ParkingRules, now = Date.now()): 'no_seeders' | 'stalled' | null {
    if (t.state !== TorrentState.DOWNLOADING) return null;
    if (t.progress >= 1) return null;
    if (t.downloadRate > 0) return null; // moving bytes → alive, however slowly
    if (t.seedsConnected > 0) return null; // a seed is connected → it can still deliver

    const addedAt = t.addedAt ? Date.parse(t.addedAt) : NaN;
    if (Number.isNaN(addedAt)) return null; // unknown age → don't judge
    const ageMs = now - addedAt;

    if (
      t.peersConnected === 0 &&
      t.seedsTotal < rules.minSeeders &&
      ageMs >= rules.deadAfterMinutes * 60_000
    ) {
      return 'no_seeders';
    }
    if (rules.stalledAfterMinutes > 0 && ageMs >= rules.stalledAfterMinutes * 60_000) {
      return 'stalled';
    }
    return null;
  }

  /** Pause + record every dead torrent, freeing its active slot. */
  private async parkDead(
    provider: TorrentEngineProvider,
    torrents: NormalizedTorrent[],
    rules: ParkingRules,
  ): Promise<number> {
    const alreadyParked = new Set(
      (await this.prisma.parkedTorrent.findMany({
        where: { engineId: provider.engineId },
        select: { hash: true },
      })).map((p) => p.hash),
    );

    let parked = 0;
    const byReason: Record<string, number> = {};
    for (const t of torrents) {
      const hash = t.hash.toLowerCase();
      if (alreadyParked.has(hash)) continue; // includes anything mid-probe
      const reason = this.deadReason(t, rules);
      if (!reason) continue;
      try {
        await provider.pauseTorrent(hash);
        await this.prisma.parkedTorrent.create({
          data: {
            hash,
            engineId: provider.engineId,
            name: t.name,
            reason,
            lastSeeders: t.seedsTotal,
          },
        });
        parked++;
        byReason[reason] = (byReason[reason] ?? 0) + 1;
      } catch (err) {
        this.logger.warn(`Failed to park ${t.name}: ${(err as Error).message}`);
      }
    }
    if (parked > 0) {
      await this.audit
        .record({
          action: 'torrents.parking.parked',
          objectType: 'torrent_engine',
          objectId: provider.engineId,
          metadata: { count: parked, ...byReason },
        })
        .catch(() => undefined);
    }
    return parked;
  }

  /**
   * Read the outcome of the probes started last tick. A probe was force-started,
   * so by now it has announced and its seeder count is fresh.
   */
  private async judgeProbes(
    provider: TorrentEngineProvider,
    byHash: Map<string, NormalizedTorrent>,
    rules: ParkingRules,
  ): Promise<{ revived: number; stillDead: number }> {
    const probing = await this.prisma.parkedTorrent.findMany({
      where: { engineId: provider.engineId, probingSince: { not: null } },
    });
    let revived = 0;
    let stillDead = 0;

    for (const row of probing) {
      const t = byHash.get(row.hash);
      if (!t) {
        // Removed from the engine behind our back — stop tracking it.
        await this.forget(provider.engineId, row.hash);
        continue;
      }
      // Revive on EVIDENCE, never on the tracker's claim. `seedsTotal` is exactly the
      // number that lies — a torrent parked as `stalled` has a tracker advertising
      // seeders while nothing connects, so trusting it here would revive the torrent
      // every probe and re-park it every tick, forever. A force-started probe that
      // has genuinely found a swarm shows it: a seed actually connected, or bytes
      // actually moving.
      const alive = t.seedsConnected > 0 || t.downloadRate > 0;
      try {
        if (alive) {
          // Hand it back to the engine's normal queue: drop force-start (so it
          // respects the queue limits like everything else) and let it run.
          await provider.forceStart(row.hash, false);
          await provider.resumeTorrent(row.hash);
          await this.forget(provider.engineId, row.hash);
          revived++;
          this.logger.log(
            `Revived "${row.name}" — ${t.seedsConnected} seed(s) connected, ${t.downloadRate} B/s`,
          );
        } else {
          await provider.forceStart(row.hash, false);
          await provider.pauseTorrent(row.hash);
          await this.prisma.parkedTorrent.update({
            where: { engineId_hash: { engineId: provider.engineId, hash: row.hash } },
            data: {
              probingSince: null,
              lastProbedAt: new Date(),
              probeCount: { increment: 1 },
              lastSeeders: t.seedsTotal,
            },
          });
          stillDead++;
        }
      } catch (err) {
        this.logger.warn(`Probe judgement failed for ${row.name}: ${(err as Error).message}`);
      }
    }

    if (revived > 0) {
      await this.audit
        .record({
          action: 'torrents.parking.revived',
          objectType: 'torrent_engine',
          objectId: provider.engineId,
          metadata: { count: revived },
        })
        .catch(() => undefined);
    }
    return { revived, stillDead };
  }

  /**
   * Force-start a batch of parked torrents so they announce and refresh their
   * seeder counts. Force-start (rather than a plain resume) is deliberate: a plain
   * resume on a full queue lands the torrent in `queuedDL`, where it does *not*
   * announce — so it would never be judged and parking would be permanent.
   */
  private async startProbes(
    provider: TorrentEngineProvider,
    byHash: Map<string, NormalizedTorrent>,
    rules: ParkingRules,
  ): Promise<number> {
    // Every candidate is considered, and they are ranked by *when the next probe
    // falls due* — not by how long ago the last one ran. Those are different orders,
    // and confusing them starves the queue: backoff grows with `probeCount`, so the
    // rows probed longest ago are exactly the rows with the longest backoff. Rank by
    // `lastProbedAt` and take a fixed window and the long-dead torrents (24h backoff,
    // never due) permanently occupy the head of it, while the freshly parked ones
    // that *are* due sort last and are never seen. Observed on synoplex: 510 parked,
    // 90 due, 0 probed per tick — parking had become a one-way trip.
    const candidates = await this.prisma.parkedTorrent.findMany({
      where: { engineId: provider.engineId, probingSince: null },
      select: { hash: true, name: true, lastProbedAt: true, probeCount: true },
    });

    const now = Date.now();
    const due = candidates
      .filter((row) => this.isProbeDue(row, rules, now))
      .sort((a, b) => this.nextProbeAt(a, rules) - this.nextProbeAt(b, rules))
      .slice(0, rules.probeBatchSize);

    let probed = 0;
    for (const row of due) {
      if (!byHash.has(row.hash)) {
        await this.forget(provider.engineId, row.hash);
        continue;
      }
      try {
        await provider.forceStart(row.hash, true);
        await this.prisma.parkedTorrent.update({
          where: { engineId_hash: { engineId: provider.engineId, hash: row.hash } },
          data: { probingSince: new Date() },
        });
        probed++;
      } catch (err) {
        this.logger.warn(`Failed to probe ${row.name}: ${(err as Error).message}`);
      }
    }
    return probed;
  }

  /**
   * When this torrent earns its next probe (epoch ms).
   *
   * Exponential backoff: a torrent dead for the tenth time is retried far less
   * often than one parked minutes ago, so 1,000 long-dead torrents don't churn the
   * engine every cycle. Never probed yet → due now (0 = maximally overdue, so a
   * newly parked torrent is probed ahead of any torrent already in backoff).
   *
   * This is the single source of truth for the backoff policy: `isProbeDue` is the
   * predicate form of it and `startProbes` ranks by it. They must not drift apart —
   * selecting on one order and filtering on the other is what starved the probe
   * queue in the first place.
   */
  nextProbeAt(row: { lastProbedAt: Date | null; probeCount: number }, rules: ParkingRules): number {
    if (!row.lastProbedAt) return 0;
    const backoff = Math.min(
      rules.probeIntervalMinutes * 2 ** Math.max(0, row.probeCount - 1),
      rules.maxProbeIntervalMinutes,
    );
    return row.lastProbedAt.getTime() + backoff * 60_000;
  }

  isProbeDue(
    row: { lastProbedAt: Date | null; probeCount: number },
    rules: ParkingRules,
    now = Date.now(),
  ): boolean {
    return now >= this.nextProbeAt(row, rules);
  }

  private forget(engineId: string, hash: string) {
    return this.prisma.parkedTorrent
      .delete({ where: { engineId_hash: { engineId, hash } } })
      .catch(() => undefined);
  }

  /** Release a torrent from parking by hand (clears force-start, resumes it). */
  async unpark(engineId: string, hash: string, userId?: string): Promise<void> {
    const provider = await this.registry.resolve(engineId);
    await provider.forceStart(hash, false);
    await provider.resumeTorrent(hash);
    await this.forget(engineId, hash);
    await this.audit
      .record({ userId, action: 'torrents.parking.unparked', objectType: 'torrent', objectId: hash })
      .catch(() => undefined);
  }
}
