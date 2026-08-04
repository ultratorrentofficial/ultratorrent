import {
  type OccupancyClass,
  holdsDownloadSlot,
  holdsSeedSlot,
  holdsTotalActiveSlot,
  isResumable,
} from './classification';
import { type TorrentPriorityDecision, orderByPriority } from './priority';
import { type SchedulerLimitation, type TorrentQueueCapabilities, canDo } from './capabilities';
import type { EffectivePolicy } from './policy';

/**
 * The planner: decide what SHOULD be running. Pure, and side-effect free.
 *
 * It takes a snapshot and returns intentions. It never calls a provider, never
 * writes a row, never reads a clock it was not given. That is what makes the
 * whole feature testable and what makes Observe Only honest — the same function
 * produces the preview and the enforced plan, so what the operator validates in
 * Observe Only is exactly what enforcement will do.
 */

export type DesiredState = 'active' | 'paused' | 'unchanged';

export interface PlannerTorrent {
  hash: string;
  engineId: string;
  occupancy: OccupancyClass;
  decision: TorrentPriorityDecision;
  policy: EffectivePolicy;
  addedAt?: Date | null;
  /** Never paused by the scheduler, whatever the limits say. */
  protectedFromPause?: boolean;
  forceStarted?: boolean;
  /** When the scheduler last changed this torrent — drives hysteresis. */
  lastActionAt?: Date | null;
  complete: boolean;
}

export interface PlannerOptions {
  /** Injected so the planner stays pure and testable. */
  now: Date;
  /** Do not pause a torrent the scheduler touched more recently than this. */
  minimumActiveSeconds?: number;
  /** A waiting torrent must beat an active one by this much to displace it. */
  priorityDisplacementThreshold?: number;
  /** Bound on state changes per sweep, so a big library settles gradually. */
  maxActionsPerSweep?: number;
}

export interface TorrentDecision {
  hash: string;
  engineId: string;
  currentOccupancy: OccupancyClass;
  desiredState: DesiredState;
  action: 'pause' | 'resume' | 'none';
  reasonCode: string;
  messageKey: string;
  values?: Record<string, unknown>;
  score: number;
  protectedFromPause: boolean;
  policySource?: string;
}

export interface EngineActivityPlan {
  engineId: string;
  decisions: TorrentDecision[];
  summary: {
    activeDownloads: number;
    activeSeeds: number;
    totalActive: number;
    queuedDownloads: number;
    queuedSeeds: number;
  };
  limitations: SchedulerLimitation[];
}

export interface TorrentActivityPlan {
  generatedAt: string;
  enginePlans: EngineActivityPlan[];
  summary: {
    activeDownloads: number;
    activeSeeds: number;
    totalActive: number;
    queuedDownloads: number;
    queuedSeeds: number;
  };
  limitations: SchedulerLimitation[];
}

const DEFAULTS = {
  minimumActiveSeconds: 120,
  priorityDisplacementThreshold: 100,
  maxActionsPerSweep: 25,
};

/** `null` means explicitly unlimited; a number is a cap. */
function withinLimit(count: number, limit: number | null): boolean {
  return limit === null || count < limit;
}

function decide(
  t: PlannerTorrent,
  desired: DesiredState,
  action: 'pause' | 'resume' | 'none',
  reasonCode: string,
  values?: Record<string, unknown>,
): TorrentDecision {
  return {
    hash: t.hash,
    engineId: t.engineId,
    currentOccupancy: t.occupancy,
    desiredState: desired,
    action,
    reasonCode,
    messageKey: `scheduler.reason.${reasonCode}`,
    values,
    score: t.decision.score,
    protectedFromPause: !!t.protectedFromPause,
    policySource: t.policy.sources.maxConcurrentDownloads
      ?? t.policy.sources.maxTotalActive
      ?? undefined,
  };
}

/**
 * Plan one engine.
 *
 * The shape of the algorithm: rank everything, walk the ranking, and give each
 * torrent a slot if one is free under ALL applicable limits. Downloads and
 * seeds have their own caps and share the total, so a seed cannot consume a
 * download's slot unless the total is what ran out — which is the distinction
 * the spec asks for and the reason total is checked separately.
 */
export function planEngine(
  engineId: string,
  torrents: PlannerTorrent[],
  caps: TorrentQueueCapabilities,
  opts: PlannerOptions,
): EngineActivityPlan {
  const cfg = { ...DEFAULTS, ...opts };
  const limitations: SchedulerLimitation[] = [];
  const decisions: TorrentDecision[] = [];

  // An engine that cannot pause cannot be managed at all. Say so once, plan
  // nothing, and let the UI explain — rather than emitting actions that will
  // certainly fail.
  if (!canDo(caps.pause)) {
    limitations.push({
      engineId,
      code: 'no_pause_support',
      messageKey: 'scheduler.limitation.no_pause_support',
    });
    return {
      engineId,
      decisions: torrents.map((t) => decide(t, 'unchanged', 'none', 'engine_cannot_pause')),
      summary: summarize(torrents),
      limitations,
    };
  }
  if (!canDo(caps.reportsQueuedState)) {
    limitations.push({
      engineId,
      code: 'no_queued_state',
      messageKey: 'scheduler.limitation.no_queued_state',
    });
  }
  if (caps.forceStart === 'approximated') {
    limitations.push({
      engineId,
      code: 'force_start_approximated',
      messageKey: 'scheduler.limitation.force_start_approximated',
    });
  }

  // Limits come from the effective policy. They are per-engine here, and the
  // first torrent's resolution is representative because engine-and-above scopes
  // are what supply them; a torrent-scoped override changes that torrent's
  // eligibility, not the engine's capacity.
  const first = torrents[0]?.policy;
  const maxDownloads = first?.maxConcurrentDownloads ?? null;
  const maxSeeds = first?.maxConcurrentSeeds ?? null;
  const maxTotal = first?.maxTotalActive ?? null;

  // Anything the scheduler must not touch is settled first and removed from
  // contention, so its slot is counted but never reassigned.
  const untouchable = torrents.filter(
    (t) => t.occupancy === 'user_paused'
      || t.occupancy === 'provider_paused'
      || t.occupancy === 'parked'
      || t.occupancy === 'error'
      || t.occupancy === 'checking'
      || t.occupancy === 'unknown',
  );
  for (const t of untouchable) {
    decisions.push(decide(t, 'unchanged', 'none', reasonForUntouchable(t.occupancy)));
  }

  const contenders = torrents.filter((t) => !untouchable.includes(t));

  // Occupied slots that cannot be reclaimed this sweep.
  let downloads = untouchable.filter((t) => holdsDownloadSlot(t.occupancy)).length;
  let seeds = untouchable.filter((t) => holdsSeedSlot(t.occupancy)).length;
  let total = untouchable.filter((t) => holdsTotalActiveSlot(t.occupancy)).length;

  const ranked = orderByPriority(
    contenders.map((t) => ({
      decision: t.decision,
      currentlyActive: holdsTotalActiveSlot(t.occupancy),
      addedAt: t.addedAt,
      torrent: t,
    })),
  );

  let actions = 0;
  const budgetLeft = () => actions < cfg.maxActionsPerSweep;

  for (const entry of ranked) {
    const t = entry.torrent;
    const wantsSeed = t.complete;
    const active = holdsTotalActiveSlot(t.occupancy);

    // Force-start bypasses the caps by design; the UI is expected to say which
    // limits it exceeds rather than the planner silently honouring them.
    if (t.forceStarted) {
      if (active) {
        decisions.push(decide(t, 'active', 'none', 'force_started_active'));
      } else if (budgetLeft()) {
        decisions.push(decide(t, 'active', 'resume', 'force_started_resume'));
        actions++;
      } else {
        decisions.push(decide(t, 'active', 'none', 'action_budget_exhausted'));
      }
      if (wantsSeed) seeds++; else downloads++;
      total++;
      continue;
    }

    const slotFree = wantsSeed
      ? withinLimit(seeds, maxSeeds) && withinLimit(total, maxTotal)
      : withinLimit(downloads, maxDownloads) && withinLimit(total, maxTotal);

    if (active) {
      if (slotFree) {
        decisions.push(decide(t, 'active', 'none', wantsSeed ? 'seeding_within_limit' : 'downloading_within_limit'));
        if (wantsSeed) seeds++; else downloads++;
        total++;
        continue;
      }
      // Over the limit. Protection and hysteresis both veto the pause.
      if (t.protectedFromPause) {
        decisions.push(decide(t, 'active', 'none', 'protected_from_pause'));
        if (wantsSeed) seeds++; else downloads++;
        total++;
        continue;
      }
      const heldFor = t.lastActionAt
        ? (cfg.now.getTime() - t.lastActionAt.getTime()) / 1000
        : Number.MAX_SAFE_INTEGER;
      if (heldFor < cfg.minimumActiveSeconds) {
        decisions.push(decide(t, 'active', 'none', 'too_recently_started', {
          seconds: Math.round(heldFor),
        }));
        if (wantsSeed) seeds++; else downloads++;
        total++;
        continue;
      }
      if (!budgetLeft()) {
        decisions.push(decide(t, 'active', 'none', 'action_budget_exhausted'));
        if (wantsSeed) seeds++; else downloads++;
        total++;
        continue;
      }
      decisions.push(decide(t, 'paused', 'pause', wantsSeed ? 'seed_limit_reached' : 'download_limit_reached', {
        limit: wantsSeed ? maxSeeds : maxDownloads,
      }));
      actions++;
      continue;
    }

    // Not active. Resume only what the scheduler is permitted to resume.
    if (!isResumable(t.occupancy)) {
      decisions.push(decide(t, 'unchanged', 'none', 'not_resumable_by_scheduler'));
      continue;
    }
    if (!slotFree) {
      decisions.push(decide(t, 'paused', 'none', wantsSeed ? 'waiting_for_seed_slot' : 'waiting_for_download_slot', {
        limit: wantsSeed ? maxSeeds : maxDownloads,
      }));
      continue;
    }
    if (!budgetLeft()) {
      decisions.push(decide(t, 'paused', 'none', 'action_budget_exhausted'));
      continue;
    }
    decisions.push(decide(t, 'active', 'resume', wantsSeed ? 'seed_slot_available' : 'download_slot_available'));
    actions++;
    if (wantsSeed) seeds++; else downloads++;
    total++;
  }

  return {
    engineId,
    decisions,
    summary: {
      activeDownloads: downloads,
      activeSeeds: seeds,
      totalActive: total,
      queuedDownloads: decisions.filter((d) => d.reasonCode === 'waiting_for_download_slot').length,
      queuedSeeds: decisions.filter((d) => d.reasonCode === 'waiting_for_seed_slot').length,
    },
    limitations,
  };
}

function reasonForUntouchable(o: OccupancyClass): string {
  switch (o) {
    case 'user_paused': return 'paused_by_user';
    case 'provider_paused': return 'paused_outside_scheduler';
    case 'parked': return 'parked_dead_swarm';
    case 'error': return 'engine_error';
    case 'checking': return 'verifying';
    default: return 'state_unknown';
  }
}

function summarize(torrents: PlannerTorrent[]) {
  return {
    activeDownloads: torrents.filter((t) => holdsDownloadSlot(t.occupancy)).length,
    activeSeeds: torrents.filter((t) => holdsSeedSlot(t.occupancy)).length,
    totalActive: torrents.filter((t) => holdsTotalActiveSlot(t.occupancy)).length,
    queuedDownloads: torrents.filter((t) => t.occupancy === 'download_queued').length,
    queuedSeeds: torrents.filter((t) => t.occupancy === 'seed_queued').length,
  };
}

/** Plan every engine. One engine's plan never depends on another's. */
export function planActivity(
  engines: Array<{ engineId: string; torrents: PlannerTorrent[]; caps: TorrentQueueCapabilities }>,
  opts: PlannerOptions,
): TorrentActivityPlan {
  const enginePlans = engines.map((e) => planEngine(e.engineId, e.torrents, e.caps, opts));
  return {
    generatedAt: opts.now.toISOString(),
    enginePlans,
    summary: enginePlans.reduce(
      (acc, p) => ({
        activeDownloads: acc.activeDownloads + p.summary.activeDownloads,
        activeSeeds: acc.activeSeeds + p.summary.activeSeeds,
        totalActive: acc.totalActive + p.summary.totalActive,
        queuedDownloads: acc.queuedDownloads + p.summary.queuedDownloads,
        queuedSeeds: acc.queuedSeeds + p.summary.queuedSeeds,
      }),
      { activeDownloads: 0, activeSeeds: 0, totalActive: 0, queuedDownloads: 0, queuedSeeds: 0 },
    ),
    limitations: enginePlans.flatMap((p) => p.limitations),
  };
}
