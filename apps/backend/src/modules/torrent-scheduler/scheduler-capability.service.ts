import { Injectable } from '@nestjs/common';
import type { EngineKind } from '@ultratorrent/shared';
import {
  UNKNOWN_QUEUE_CAPABILITIES,
  type TorrentQueueCapabilities,
} from './domain/capabilities';

/**
 * What each shipped engine can actually do about queueing.
 *
 * Deliberately a lookup here rather than a new method on `TorrentEngineProvider`.
 * Phase 3 observes and must not change the provider contract: adding
 * `getQueueCapabilities()` to the interface obliges every engine — including any
 * a user has written — to implement it, and that is a Phase 4 conversation once
 * reconciliation actually needs the call.
 *
 * The grades are read off the providers' own code, not aspiration:
 *
 *  - **rTorrent** normalizes `complete → SEEDING` and everything else running to
 *    `DOWNLOADING`, with no `QUEUED` anywhere — so it cannot report a queued
 *    torrent. Its `forceStart` says in a comment that rTorrent "has no force
 *    flag; priority 3 (high) is the closest equivalent", which is the definition
 *    of `approximated`.
 *  - **qBittorrent** maps a real `queued` state and sets a real force flag.
 *
 * Neither exposes a global rate limit through this application's provider
 * interface — only `setUploadLimit(hash, …)` per torrent — so global bandwidth
 * policy is `unsupported` on both until the contract grows. Saying so is the
 * point: a policy that cannot be enforced must be visible as such.
 *
 * Seed DURATION is unsupported everywhere because nothing in this repository
 * records it. `completedAt` is not seed time — a torrent paused for a week
 * accrues no seeding while its completion date ages — so time-based seed targets
 * are unenforceable today and are reported that way rather than silently
 * treating an unknown as zero.
 */
@Injectable()
export class SchedulerCapabilityService {
  private readonly byKind: Partial<Record<EngineKind, TorrentQueueCapabilities>> = {
    qbittorrent: {
      ...UNKNOWN_QUEUE_CAPABILITIES,
      pause: 'native',
      resume: 'native',
      queuePosition: 'native',
      forceStart: 'native',
      reportsQueuedState: 'native',
      ratioReporting: 'native',
      perTorrentDownloadRateLimit: 'native',
      perTorrentUploadRateLimit: 'native',
      // qBittorrent HAS native queue limits; this application's provider
      // interface simply exposes no way to read or write them yet.
      activeDownloadLimit: 'unsupported',
      activeSeedLimit: 'unsupported',
      totalActiveLimit: 'unsupported',
      nativeQueueModel: 'separate-download-seed',
    },
    rtorrent: {
      ...UNKNOWN_QUEUE_CAPABILITIES,
      pause: 'native',
      resume: 'native',
      // Priority 3 rather than a force flag.
      forceStart: 'approximated',
      // No QUEUED state exists in the normalizer at all.
      reportsQueuedState: 'unsupported',
      ratioReporting: 'native',
      perTorrentDownloadRateLimit: 'native',
      perTorrentUploadRateLimit: 'native',
      nativeQueueModel: 'provider-specific',
    },
  };

  /**
   * An engine kind we have not characterised is credited with nothing.
   *
   * The failure mode being avoided: the scheduler believing it enforced a limit
   * it never applied. Under-claiming produces a visible limitation; over-claiming
   * produces a silent lie.
   */
  for(kind: EngineKind): TorrentQueueCapabilities {
    return this.byKind[kind] ?? UNKNOWN_QUEUE_CAPABILITIES;
  }
}
