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
   * A torrent is dead when it is *actively holding a slot* yet nothing is
   * happening: no bytes moving, nobody connected, and the tracker knows of no
   * seeders — after a grace period, since a freshly-added torrent legitimately
   * looks like this for a moment.
   *
   * Only `DOWNLOADING` counts (qBittorrent maps `metaDL`/`stalledDL` to it) —
   * those are the states that consume an active slot. A QUEUED torrent isn't
   * costing anything and hasn't announced recently enough to be judged fairly,
   * and a PAUSED one was paused by someone; leave both alone.
   */
  isDead(t: NormalizedTorrent, rules: ParkingRules, now = Date.now()): boolean {
    if (t.state !== TorrentState.DOWNLOADING) return false;
    if (t.progress >= 1) return false;
    if (t.downloadRate > 0) return false;
    if (t.seedsConnected > 0 || t.peersConnected > 0) return false;
    if (t.seedsTotal >= rules.minSeeders) return false; // the swarm exists; give it time
    const addedAt = t.addedAt ? Date.parse(t.addedAt) : NaN;
    if (Number.isNaN(addedAt)) return false; // unknown age → don't judge
    return now - addedAt >= rules.deadAfterMinutes * 60_000;
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
    for (const t of torrents) {
      const hash = t.hash.toLowerCase();
      if (alreadyParked.has(hash)) continue; // includes anything mid-probe
      if (!this.isDead(t, rules)) continue;
      try {
        await provider.pauseTorrent(hash);
        await this.prisma.parkedTorrent.create({
          data: {
            hash,
            engineId: provider.engineId,
            name: t.name,
            reason: 'no_seeders',
            lastSeeders: t.seedsTotal,
          },
        });
        parked++;
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
          metadata: { count: parked, reason: 'no_seeders' },
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
      const alive = t.seedsTotal >= rules.minSeeders || t.seedsConnected > 0 || t.downloadRate > 0;
      try {
        if (alive) {
          // Hand it back to the engine's normal queue: drop force-start (so it
          // respects the queue limits like everything else) and let it run.
          await provider.forceStart(row.hash, false);
          await provider.resumeTorrent(row.hash);
          await this.forget(provider.engineId, row.hash);
          revived++;
          this.logger.log(`Revived "${row.name}" — ${t.seedsTotal} seeder(s) reappeared`);
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
    const candidates = await this.prisma.parkedTorrent.findMany({
      where: { engineId: provider.engineId, probingSince: null },
      orderBy: [{ lastProbedAt: { sort: 'asc', nulls: 'first' } }, { parkedAt: 'asc' }],
      take: rules.probeBatchSize * 4, // over-fetch: most are still in backoff
    });

    const now = Date.now();
    const due = candidates.filter((row) => this.isProbeDue(row, rules, now)).slice(0, rules.probeBatchSize);

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
   * Exponential backoff: a torrent dead for the tenth time is retried far less
   * often than one parked minutes ago, so 1,000 long-dead torrents don't churn the
   * engine every cycle. Never probed yet → always due.
   */
  isProbeDue(
    row: { lastProbedAt: Date | null; probeCount: number },
    rules: ParkingRules,
    now = Date.now(),
  ): boolean {
    if (!row.lastProbedAt) return true;
    const backoff = Math.min(
      rules.probeIntervalMinutes * 2 ** Math.max(0, row.probeCount - 1),
      rules.maxProbeIntervalMinutes,
    );
    return now - row.lastProbedAt.getTime() >= backoff * 60_000;
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
