import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NormalizedTorrent } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { TorrentEngineProvider } from '../../domain/engine/torrent-engine-provider.interface';
import { accrue, isEmpty, shareRatio, TransferBaseline } from './domain/accrual';

/** What the UI asks for: a total that survives everything. */
export interface LedgerTotals {
  downloaded: bigint;
  uploaded: bigint;
  ratio: number;
}

export const EMPTY_TOTALS: LedgerTotals = {
  downloaded: 0n,
  uploaded: 0n,
  ratio: 0,
};

/** The snapshot fields the ledger needs, over and above the sync loop's own. */
export interface LedgerBaselineRow extends TransferBaseline {
  hash: string;
}

/**
 * Persistent transfer statistics.
 *
 * Before this existed, "total downloaded" was computed by summing the torrents
 * an engine currently held. That number is not a total — it is a census of the
 * survivors, and it falls every time a torrent is removed. On a library that
 * recycles its queue it reported a small fraction of the real history, and an
 * engine rebuilt from scratch reported nothing at all.
 *
 * The ledger banks bytes as they move, in Postgres, so removing a torrent,
 * restarting an engine or rebuilding its container cannot take them back. The
 * arithmetic lives in `domain/accrual.ts`; this service is the part that has to
 * touch a database and an engine.
 */
@Injectable()
export class TransferLedgerService {
  private readonly logger = new Logger(TransferLedgerService.name);

  /**
   * Engines whose baseline has been settled this process. Seeding is a one-off
   * per engine and the row is authoritative afterwards, so this only avoids a
   * repeated no-op query on the 2-second sync loop.
   */
  private readonly baselined = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The persisted total for one engine, or across all of them.
   *
   * Baseline and accrued are summed here rather than in the database so the two
   * stay separately auditable — see the model docs for why that split exists.
   */
  async totals(engineId?: string): Promise<LedgerTotals> {
    const rows = await this.prisma.transferLedger.findMany({
      where: engineId ? { engineId } : undefined,
      select: {
        baselineDownloaded: true,
        baselineUploaded: true,
        accruedDownloaded: true,
        accruedUploaded: true,
      },
    });

    let downloaded = 0n;
    let uploaded = 0n;
    for (const r of rows) {
      downloaded += r.baselineDownloaded + r.accruedDownloaded;
      uploaded += r.baselineUploaded + r.accruedUploaded;
    }
    return { downloaded, uploaded, ratio: shareRatio(downloaded, uploaded) };
  }

  /**
   * Establish an engine's starting point, once.
   *
   * An engine adopted today may have been transferring for months, and that
   * history is real even though we were not watching. Where the engine keeps
   * its own all-time counter we take it; qBittorrent does, and on a live
   * install the difference was 886 GiB of history against 41 GiB of survivors.
   *
   * Where it does not — rTorrent's global counters reset when the daemon does,
   * so they are a session figure wearing an all-time badge — we fall back to
   * summing what the engine currently holds. That understates the past, but it
   * understates it *once*, and everything after is exact.
   *
   * Deliberately not retried on failure: a wrong baseline is permanent, so
   * leaving the row unseeded and trying again next tick is the safer failure.
   */
  async ensureBaseline(provider: TorrentEngineProvider): Promise<void> {
    const engineId = provider.engineId;
    if (this.baselined.has(engineId)) return;

    const existing = await this.prisma.transferLedger.findUnique({
      where: { engineId },
      select: { baselineAt: true },
    });
    if (existing?.baselineAt) {
      this.baselined.add(engineId);
      return;
    }

    const seed = await this.seedValues(provider);
    if (!seed) return; // try again next tick rather than bank a wrong number

    await this.prisma.transferLedger.upsert({
      where: { engineId },
      create: {
        engineId,
        baselineDownloaded: seed.downloaded,
        baselineUploaded: seed.uploaded,
        baselineSource: seed.source,
        baselineAt: new Date(),
      },
      update: {
        baselineDownloaded: seed.downloaded,
        baselineUploaded: seed.uploaded,
        baselineSource: seed.source,
        baselineAt: new Date(),
      },
    });
    this.baselined.add(engineId);
    this.logger.log(
      `Transfer ledger baseline for ${engineId}: ` +
        `${seed.downloaded} down / ${seed.uploaded} up (${seed.source})`,
    );
  }

  private async seedValues(
    provider: TorrentEngineProvider,
  ): Promise<{ downloaded: bigint; uploaded: bigint; source: string } | null> {
    try {
      const allTime = await provider.getAllTimeStats?.();
      if (allTime) {
        return { ...allTime, source: 'engine_alltime' };
      }
    } catch (err) {
      this.logger.warn(
        `All-time stats unavailable for ${provider.engineId}: ${(err as Error).message}`,
      );
      return null;
    }

    try {
      const torrents = await provider.listTorrents();
      return {
        downloaded: torrents.reduce((a, t) => a + BigInt(Math.round(t.downloaded)), 0n),
        uploaded: torrents.reduce((a, t) => a + BigInt(Math.round(t.uploaded)), 0n),
        source: 'current_torrents',
      };
    } catch {
      return null;
    }
  }

  /**
   * The write that banks this sync's bytes.
   *
   * Returned as a Prisma operation rather than executed, so the caller can put
   * it in the **same transaction** as the snapshot upserts. That is not tidiness:
   * the delta is measured against the snapshots, so a run that updates the
   * snapshots without updating the ledger loses those bytes permanently — the
   * next pass measures from the new snapshot and never sees them. Either both
   * land or neither does.
   *
   * Returns `null` when nothing moved, which on an engine full of parked
   * torrents is most ticks. Skipping the write keeps a 2-second loop from
   * rewriting an unchanged row 43,000 times a day.
   */
  accrualOperation(
    engineId: string,
    torrents: readonly NormalizedTorrent[],
    prior: ReadonlyMap<string, TransferBaseline>,
  ): Prisma.PrismaPromise<unknown> | null {
    const result = accrue(
      torrents.map((t) => ({
        hash: t.hash,
        downloaded: BigInt(Math.round(t.downloaded)),
        uploaded: BigInt(Math.round(t.uploaded)),
      })),
      prior,
    );
    if (isEmpty(result)) return null;

    return this.prisma.transferLedger.upsert({
      where: { engineId },
      create: {
        engineId,
        accruedDownloaded: result.downloaded,
        accruedUploaded: result.uploaded,
        resetsObserved: result.resets,
      },
      update: {
        accruedDownloaded: { increment: result.downloaded },
        accruedUploaded: { increment: result.uploaded },
        resetsObserved: { increment: result.resets },
      },
    });
  }

  /**
   * Record the torrents about to be pruned from the snapshot table.
   *
   * The ledger does not need these rows — their bytes were banked while they
   * were still present, which is the property that makes removal harmless. They
   * exist so a total can be *explained*: without them "886 GiB" is a number
   * with no way back to the torrents that produced it.
   *
   * Best-effort. Provenance is worth having and never worth failing a sync for.
   */
  async archiveRetired(
    engineId: string,
    liveHashes: readonly string[],
  ): Promise<void> {
    try {
      const departing = await this.prisma.torrentSnapshot.findMany({
        where: { engineId, hash: { notIn: [...liveHashes] } },
        select: {
          hash: true,
          name: true,
          downloaded: true,
          uploaded: true,
          ratio: true,
          addedAt: true,
        },
      });
      if (!departing.length) return;

      const retiredAt = new Date();
      await this.prisma.retiredTorrentTransfer.createMany({
        data: departing.map((d) => ({
          engineId,
          hash: d.hash,
          name: d.name,
          downloaded: d.downloaded,
          uploaded: d.uploaded,
          ratio: d.ratio,
          firstSeenAt: d.addedAt,
          retiredAt,
        })),
        skipDuplicates: true,
      });
    } catch (err) {
      this.logger.warn(
        `Could not archive retired torrents for ${engineId}: ${(err as Error).message}`,
      );
    }
  }
}
