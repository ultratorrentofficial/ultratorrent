import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DOMAIN_EVENTS, type DiscoveryCapability } from '@ultratorrent/shared';
import { DomainEventBus } from '../domain-events/domain-event-bus.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { DiscoveryProviderRegistry } from './discovery-provider-registry.service';
import { DiscoveryStoreService } from './discovery-store.service';
import { mergeDiscoveries, type SourcedDiscovery } from './discovery-identity';
import type { DiscoveryQuery, ReleaseDiscoveryProvider } from './discovery-provider';

/** The ticker wakes hourly; `SYNC_INTERVAL_MS` decides whether it acts. */
const TICK_MS = 60 * 60_000;
/** How stale a provider's catalogue may get before it is refreshed. */
const SYNC_INTERVAL_MS = 6 * 60 * 60_000;

/** Rows one capability may contribute per sync. */
const PER_CAPABILITY_LIMIT = 200;

/** How far ahead a catalogue sync looks, independent of any template's window. */
const SYNC_WINDOW_DAYS = 180;

/** Capabilities a catalogue sync pulls. Trending/popular are not catalogue data. */
const SYNCED: DiscoveryCapability[] = [
  'upcoming_movies',
  'upcoming_series',
  'upcoming_seasons',
  'returning_series',
];

/** What asking ONE provider produced, before the global merge decides counts. */
interface CollectOutcome {
  provider: string;
  durationMs: number;
  /** True only when the provider failed AND returned nothing at all. */
  anyFailed: boolean;
  error?: string;
  capabilities: DiscoveryCapability[];
}

export interface SyncOutcome {
  provider: string;
  discovered: number;
  created: number;
  updated: number;
  failed: number;
  /** Reported by upstream, held back because somebody removed it here. */
  suppressed: number;
  durationMs: number;
  error?: string;
}

/**
 * Refreshes each provider's catalogue into `discovered_media`.
 *
 * Three properties this deliberately has:
 *
 *  - **A provider is silent until an operator enables it.** `DiscoveryProviderState`
 *    starts `enabled: false`, so a fresh install makes no third-party calls at
 *    all. Discovering is cheap for us and not free for them.
 *  - **Nothing here decides anything.** A sync writes rows and updates counters.
 *    Evaluating templates, creating watchlist entries and generating rules are
 *    later, separate steps — so a catalogue refresh can never, by itself, cause
 *    an acquisition.
 *  - **A failure keeps the previous catalogue.** A provider that throws is marked
 *    unhealthy and its rows are left exactly as they were. Emptying a catalogue
 *    because a network call failed would read downstream as "nothing is coming
 *    out".
 */
@Injectable()
export class DiscoverySyncService {
  private readonly logger = new Logger(DiscoverySyncService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: DiscoveryProviderRegistry,
    private readonly store: DiscoveryStoreService,
    private readonly bus: DomainEventBus,
  ) {}

  @Interval('media_discovery_provider_sync', TICK_MS)
  async tick(): Promise<void> {
    try {
      const due = await this.dueProviders();
      if (due.length === 0) return;
      await this.syncProviders(due);
    } catch (err) {
      // A scheduler tick must never throw: an unhandled rejection here takes the
      // interval down with it and the sweep silently stops forever.
      this.logger.error(`Discovery sync tick failed: ${(err as Error).message}`);
    }
  }

  /** Enabled providers whose catalogue is older than the refresh interval. */
  private async dueProviders(): Promise<string[]> {
    const rows = await this.prisma.discoveryProviderState.findMany({
      where: { enabled: true },
      select: { provider: true, lastSuccessfulSync: true },
    });
    const cutoff = Date.now() - SYNC_INTERVAL_MS;
    return rows
      .filter((r) => !r.lastSuccessfulSync || r.lastSuccessfulSync.getTime() < cutoff)
      .map((r) => r.provider);
  }

  /**
   * Sync the named providers.
   *
   * Serialized rather than parallel: these are rate-limited third-party APIs, and
   * two providers hammering them at once to save a few seconds on a six-hourly
   * job is a poor trade.
   */
  async syncProviders(names: string[]): Promise<SyncOutcome[]> {
    if (this.running) {
      this.logger.warn('Discovery sync already running — skipping this tick');
      return [];
    }
    this.running = true;
    try {
      /*
       * Collect from every provider FIRST, then merge once across all of them.
       *
       * Merging per provider looked equivalent and is not: the title+year join
       * only ever fires between records from DIFFERENT providers, so merging each
       * provider's haul in isolation makes that rule unreachable. Measured — a
       * per-provider merge produced 818 rows and **zero** cross-provider joins
       * from data that joins 37 shows when merged together. The store's id-based
       * matching cannot recover them either, because TMDB reports `tmdb:` ids and
       * TVmaze reports `tvmaze:`/`tvdb:`/`imdb:` ones, so there is frequently no
       * id in common to match on.
       *
       * Collection stays per provider because health, timing and counts are per
       * provider; only the merge is global.
       */
      const collected: SourcedDiscovery[] = [];
      const partial: CollectOutcome[] = [];

      for (const name of names) {
        const provider = this.registry.get(name);
        if (!provider) {
          this.logger.warn(`Discovery provider "${name}" is enabled but not registered`);
          continue;
        }
        partial.push(await this.collect(provider, collected));
      }

      const merged = mergeDiscoveries(collected);
      const result = await this.store.persist(merged);

      const outcomes: SyncOutcome[] = [];
      for (const p of partial) {
        const mine = merged.filter((m) => m.sourceProviders.includes(p.provider)).length;
        await this.recordState(p, mine);
        outcomes.push({
          provider: p.provider,
          discovered: mine,
          // Writes are one pass over the merged set, so per-provider create/update
          // counts do not exist. Reporting the pass totals against each provider
          // would double-count; reporting zero would look like nothing happened.
          created: result.created,
          updated: result.updated,
          failed: result.failed,
          suppressed: result.suppressed,
          durationMs: p.durationMs,
          ...(p.error ? { error: p.error } : {}),
        });
      }
      return outcomes;
    } finally {
      this.running = false;
    }
  }

  /** Ask one provider everything it can answer, appending to the shared pile. */
  private async collect(
    provider: ReleaseDiscoveryProvider,
    into: SourcedDiscovery[],
  ): Promise<CollectOutcome> {
    const started = Date.now();
    await this.mark(provider.name, { lastSyncStartedAt: new Date() });

    const query: DiscoveryQuery = { windowDays: SYNC_WINDOW_DAYS, limit: PER_CAPABILITY_LIMIT };
    let anyFailed = false;
    let error: string | undefined;
    let got = 0;

    for (const capability of SYNCED) {
      if (!provider.capabilities().includes(capability)) continue;
      try {
        const rows = await this.call(provider, capability, query);
        got += rows.length;
        into.push(...rows.map((raw) => ({ provider: provider.name, raw })));
      } catch (err) {
        anyFailed = true;
        error = (err as Error).message;
        this.logger.warn(`${provider.name}/${capability} failed: ${error}`);
      }
    }

    return {
      provider: provider.name,
      durationMs: Date.now() - started,
      anyFailed: anyFailed && got === 0,
      ...(error ? { error } : {}),
      capabilities: provider.capabilities(),
    };
  }

  private async recordState(p: CollectOutcome, discovered: number): Promise<void> {
    if (p.anyFailed) {
      /*
       * Nothing came back and something broke: keep whatever is already stored
       * rather than recording a successful empty sync. "We could not ask" and
       * "nothing is coming out" are very different claims — and the notification
       * says which, because an operator seeing an unchanged catalogue would
       * otherwise have no way to tell them apart.
       */
      this.bus.publish({
        eventKey: DOMAIN_EVENTS.MEDIA_DISCOVERY_PROVIDER_SYNC_FAILED,
        resourceType: 'discovery_provider',
        resourceId: p.provider,
        payload: {
          provider: p.provider,
          providerName: p.provider,
          reason: p.error ?? 'Sync returned nothing',
        },
      });
      await this.mark(p.provider, {
        healthy: false,
        lastFailureAt: new Date(),
        lastFailureReason: p.error ?? 'Sync returned nothing',
        lastResponseMs: p.durationMs,
      });
      return;
    }
    await this.mark(p.provider, {
      healthy: !p.error,
      lastSuccessfulSync: new Date(),
      lastResponseMs: p.durationMs,
      itemsDiscovered: discovered,
      capabilities: p.capabilities,
      ...(p.error ? { lastFailureAt: new Date(), lastFailureReason: p.error } : {}),
    });
  }

  /** Dispatch a capability to the method that serves it. */
  private call(
    provider: ReleaseDiscoveryProvider,
    capability: DiscoveryCapability,
    query: DiscoveryQuery,
  ) {
    switch (capability) {
      case 'upcoming_movies':
        return provider.getUpcomingMovies!(query);
      case 'upcoming_series':
        return provider.getUpcomingSeries!(query);
      case 'upcoming_seasons':
        return provider.getUpcomingSeasons!(query);
      case 'returning_series':
        return provider.getReturningSeries!(query);
      default:
        return Promise.resolve([]);
    }
  }

  /** Upsert provider state. Never throws — bookkeeping must not fail a sync. */
  private async mark(provider: string, data: Record<string, unknown>): Promise<void> {
    try {
      await this.prisma.discoveryProviderState.upsert({
        where: { provider },
        create: { provider, ...(data as object) },
        update: data as object,
      });
    } catch (err) {
      this.logger.warn(`Could not record state for ${provider}: ${(err as Error).message}`);
    }
  }
}
