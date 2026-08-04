import { TorrentState } from '@ultratorrent/shared';
import { type TorrentQueueCapabilities, canDo } from './capabilities';

/**
 * What a torrent is occupying, as distinct from what state the engine reports.
 *
 * The engine's state is not the answer. Two examples from the shipped providers:
 *
 *  - rTorrent maps everything running-and-incomplete to `DOWNLOADING`, so a
 *    torrent waiting for a slot looks identical to one transferring. Occupancy
 *    has to be INFERRED there, and said to be inferred.
 *  - Every paused torrent reports `PAUSED`, whether a person paused it, the
 *    scheduler paused it to free a slot, or the engine paused it on error.
 *    Collapsing those loses the one fact that decides whether we may resume it.
 *
 * So classification takes provider state, scheduler-owned state, and engine
 * capabilities, and produces an occupancy class plus an honest confidence.
 */

export type OccupancyClass =
  /** Actively receiving payload, or reported as downloading. */
  | 'download_active'
  /** Complete and eligible to upload — whether or not a peer is connected. */
  | 'seed_active'
  /** Wants to download, holding no slot. */
  | 'download_queued'
  /** Complete, wants to seed, holding no slot. */
  | 'seed_queued'
  /** A person paused it. Never auto-resumed. */
  | 'user_paused'
  /** The scheduler paused it. May be resumed when eligible. */
  | 'scheduler_paused'
  /** The engine paused/stopped it for its own reasons (error, disk, …). */
  | 'provider_paused'
  /** Verifying — occupies the machine but is neither download nor seed. */
  | 'checking'
  | 'error'
  /** Held out of the queue by the parking service because its swarm is dead. */
  | 'parked'
  /**
   * The operator put this torrent outside the scheduler's authority. Distinct
   * from protection: a protected torrent still counts toward limits and may
   * still be resumed, an excluded one is not the scheduler's business at all.
   */
  | 'excluded'
  /** Not enough information to say. Never acted upon. */
  | 'unknown';

export interface ClassificationInput {
  state: TorrentState;
  progress: number;
  downloadRate: number;
  uploadRate: number;
  /** Scheduler-owned: did WE pause this? */
  schedulerPaused?: boolean;
  /** Scheduler-owned: did a person pause it? */
  userPaused?: boolean;
  /** True when `TorrentParkingService` is holding it out of the queue. */
  parked?: boolean;
  forceStarted?: boolean;
}

export interface Classification {
  occupancy: OccupancyClass;
  /**
   * `reported` — the engine said so.
   * `inferred` — derived, because the engine cannot express it.
   * `unknown` — neither; the planner must not act on this torrent.
   */
  confidence: 'reported' | 'inferred' | 'unknown';
  /** Stable code explaining the classification, for the queue-reason UI. */
  reasonCode: string;
}

const COMPLETE = 1;

/**
 * Classify one torrent.
 *
 * Order matters: the most authoritative fact wins. Scheduler-owned pause state
 * beats the engine's generic `PAUSED`, because only we know why. Parking beats
 * both — a parked torrent is paused BY US for a specific reason, and resuming it
 * is the parking service's decision, not the scheduler's.
 */
export function classify(
  input: ClassificationInput,
  caps: TorrentQueueCapabilities,
): Classification {
  const complete = input.progress >= COMPLETE;

  // Parking owns this torrent. See the module note on coexistence: the
  // scheduler treats it as ineligible rather than fighting for control.
  if (input.parked) {
    return { occupancy: 'parked', confidence: 'reported', reasonCode: 'parked_dead_swarm' };
  }

  if (input.state === TorrentState.ERROR) {
    return { occupancy: 'error', confidence: 'reported', reasonCode: 'engine_error' };
  }
  if (input.state === TorrentState.CHECKING || input.state === TorrentState.ALLOCATING) {
    return { occupancy: 'checking', confidence: 'reported', reasonCode: 'verifying' };
  }

  if (input.state === TorrentState.PAUSED || input.state === TorrentState.STOPPED) {
    // A person's pause is a decision, and outranks ours — resuming it would
    // undo an explicit human action.
    if (input.userPaused) {
      return { occupancy: 'user_paused', confidence: 'reported', reasonCode: 'paused_by_user' };
    }
    if (input.schedulerPaused) {
      return {
        occupancy: 'scheduler_paused',
        confidence: 'reported',
        reasonCode: 'paused_by_scheduler',
      };
    }
    // Paused, and nobody here claims responsibility. It might be a user pause
    // from before the scheduler existed, so it is NOT ours to resume.
    return {
      occupancy: 'provider_paused',
      confidence: 'inferred',
      reasonCode: 'paused_outside_scheduler',
    };
  }

  if (input.state === TorrentState.QUEUED) {
    return complete
      ? { occupancy: 'seed_queued', confidence: 'reported', reasonCode: 'queued_seed' }
      : { occupancy: 'download_queued', confidence: 'reported', reasonCode: 'queued_download' };
  }

  if (input.state === TorrentState.SEEDING || (complete && input.state === TorrentState.COMPLETED)) {
    // A seed with no leechers is still occupying a seed slot. Requiring
    // uploadRate > 0 would free slots that are not actually free.
    return { occupancy: 'seed_active', confidence: 'reported', reasonCode: 'seeding' };
  }

  if (input.state === TorrentState.DOWNLOADING) {
    if (complete) {
      return { occupancy: 'seed_active', confidence: 'inferred', reasonCode: 'complete_and_running' };
    }
    // The rTorrent case: no queued state exists, so a stalled torrent at zero
    // bytes may in truth be waiting for a slot. Say so rather than assert it is
    // transferring.
    if (!canDo(caps.reportsQueuedState) && input.downloadRate === 0) {
      return {
        occupancy: 'download_active',
        confidence: 'inferred',
        reasonCode: 'active_or_queued_indistinguishable',
      };
    }
    return { occupancy: 'download_active', confidence: 'reported', reasonCode: 'downloading' };
  }

  return { occupancy: 'unknown', confidence: 'unknown', reasonCode: 'state_unknown' };
}

/** Does this class hold a download slot? */
export function holdsDownloadSlot(o: OccupancyClass): boolean {
  return o === 'download_active';
}

/** Does this class hold a seed slot? */
export function holdsSeedSlot(o: OccupancyClass): boolean {
  return o === 'seed_active';
}

/**
 * Does this class count toward the TOTAL active limit?
 *
 * Checking counts: it occupies the engine and competes for disk, even though it
 * is neither downloading nor seeding. Excluding it would let a recheck storm
 * exceed a total-active limit the operator set precisely to bound load.
 */
export function holdsTotalActiveSlot(o: OccupancyClass): boolean {
  return o === 'download_active' || o === 'seed_active' || o === 'checking';
}

/** Is the scheduler allowed to resume this, if a slot opens? */
export function isResumable(o: OccupancyClass): boolean {
  return o === 'scheduler_paused' || o === 'download_queued' || o === 'seed_queued';
}
