/**
 * What an engine can actually do about queueing, as opposed to what we wish it
 * could.
 *
 * The scheduler decides policy; a provider executes it. That split only holds if
 * the scheduler can ask what is executable, because the two shipped engines
 * differ in ways that change the ANSWER, not merely the syntax:
 *
 *  - qBittorrent reports a real `queued` state. rTorrent's normalizer maps
 *    `complete → SEEDING` and everything else running to `DOWNLOADING`, so a
 *    torrent waiting for a slot is indistinguishable from one actively
 *    transferring. "How many downloads are queued" is unanswerable there from
 *    provider state alone.
 *  - `forceStart` exists on both, but qBittorrent sets a real force flag while
 *    rTorrent's provider says outright: "rTorrent has no force flag; priority 3
 *    (high) is the closest equivalent". A boolean `supportsForceStart` would
 *    make those look identical and let the UI promise something one engine
 *    cannot deliver.
 *
 * So capabilities are reported in three grades wherever approximation is real.
 * `approximated` is not a lesser `true`; it is a promise that the effect is
 * best-effort and must be surfaced to the operator rather than assumed.
 */

/** How faithfully an engine can perform an operation. */
export type CapabilityGrade =
  /** Does exactly this, and reports it. */
  | 'native'
  /** Achieves something close by another mechanism; the difference is visible. */
  | 'approximated'
  /** Cannot do it at all. */
  | 'unsupported';

/**
 * How the engine models its own queue.
 *
 * `none` matters: an engine with no queue concept cannot be "coordinated" with,
 * only replaced — which is a different activation conversation.
 */
export type NativeQueueModel =
  | 'none'
  | 'combined'
  | 'separate-download-seed'
  | 'provider-specific';

export interface TorrentQueueCapabilities {
  /** Stop a torrent transferring while keeping it loaded. */
  pause: CapabilityGrade;
  resume: CapabilityGrade;

  /** Read/write the engine's OWN queue limits, so conflicts can be detected. */
  readNativeQueueSettings: CapabilityGrade;
  writeNativeQueueSettings: CapabilityGrade;

  activeDownloadLimit: CapabilityGrade;
  activeSeedLimit: CapabilityGrade;
  totalActiveLimit: CapabilityGrade;

  globalDownloadRateLimit: CapabilityGrade;
  globalUploadRateLimit: CapabilityGrade;
  perTorrentDownloadRateLimit: CapabilityGrade;
  perTorrentUploadRateLimit: CapabilityGrade;

  queuePosition: CapabilityGrade;
  /** qBittorrent: a real flag. rTorrent: priority 3 — hence `approximated`. */
  forceStart: CapabilityGrade;

  /**
   * Whether the engine distinguishes a queued torrent from a transferring one.
   * When `unsupported`, queue occupancy must be inferred and said to be inferred.
   */
  reportsQueuedState: CapabilityGrade;

  ratioReporting: CapabilityGrade;
  /**
   * Seed DURATION, not completion time. Nothing in this repository tracks it
   * today, so a `time`-based seeding policy is unenforceable wherever this is
   * `unsupported` — and must be reported as such rather than silently treated
   * as zero.
   */
  seedTimeReporting: CapabilityGrade;
  availabilityReporting: CapabilityGrade;

  nativeQueueModel: NativeQueueModel;
}

/**
 * The safe assumption for an engine that has not been asked yet.
 *
 * Everything unsupported: an unknown engine must not be credited with
 * capabilities it may not have, because the failure mode is the scheduler
 * believing it enforced a limit it never applied.
 */
export const UNKNOWN_QUEUE_CAPABILITIES: TorrentQueueCapabilities = {
  pause: 'unsupported',
  resume: 'unsupported',
  readNativeQueueSettings: 'unsupported',
  writeNativeQueueSettings: 'unsupported',
  activeDownloadLimit: 'unsupported',
  activeSeedLimit: 'unsupported',
  totalActiveLimit: 'unsupported',
  globalDownloadRateLimit: 'unsupported',
  globalUploadRateLimit: 'unsupported',
  perTorrentDownloadRateLimit: 'unsupported',
  perTorrentUploadRateLimit: 'unsupported',
  queuePosition: 'unsupported',
  forceStart: 'unsupported',
  reportsQueuedState: 'unsupported',
  ratioReporting: 'unsupported',
  seedTimeReporting: 'unsupported',
  availabilityReporting: 'unsupported',
  nativeQueueModel: 'none',
};

/** True when the grade permits acting at all (natively or approximately). */
export function canDo(grade: CapabilityGrade): boolean {
  return grade === 'native' || grade === 'approximated';
}

/**
 * A policy the engine cannot honour exactly, stated plainly.
 *
 * Carried on the plan so the UI can say what will actually happen. The spec's
 * rule — never silently claim full enforcement — is only keepable if the
 * planner records the shortfall at the moment it discovers it.
 */
export interface SchedulerLimitation {
  engineId: string;
  /** Stable code for i18n and tests. */
  code:
    | 'no_pause_support'
    | 'no_seed_time_data'
    | 'no_queued_state'
    | 'no_global_rate_limit'
    | 'no_per_torrent_rate_limit'
    | 'force_start_approximated'
    | 'native_queue_conflict'
    | 'no_availability_data';
  messageKey: string;
  values?: Record<string, unknown>;
}
