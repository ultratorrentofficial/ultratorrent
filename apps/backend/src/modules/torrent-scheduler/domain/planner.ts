import {
  type OccupancyClass,
  holdsDownloadSlot,
  holdsSeedSlot,
  holdsTotalActiveSlot,
  isResumable,
} from './classification';
import { type TorrentPriorityDecision, orderByPriority } from './priority';
import { type SchedulerLimitation, type TorrentQueueCapabilities, canDo } from './capabilities';
import { evaluateSeedAgeDeadline, evaluateSeedTarget, type EffectivePolicy } from './policy';
import { unmeasurableFields, type SeedFacts } from './seed-conditions';

/**
 * The planner: decide what SHOULD be running. Pure, and side-effect free.
 *
 * It takes a snapshot and returns intentions. It never calls a provider, never
 * writes a row, never reads a clock it was not given. That is what makes the
 * whole feature testable and what makes Observe Only honest — the same function
 * produces the preview and the enforced plan, so what the operator validates in
 * Observe Only is exactly what enforcement will do.
 */

export type DesiredState = 'active' | 'paused' | 'unchanged' | 'removed';

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

  /** Share ratio, when the engine reports one. Never assumed. */
  ratio?: number;
  /*
   * Facts a seeding policy's CONDITIONS can be written against.
   *
   * All optional, and absent rather than defaulted when unknown: substituting a
   * zero would turn "never measured" into a real value, and a rule reading
   * `ratio < 1` would then match every torrent the engine had not reported on.
   */
  sizeBytes?: number;
  uploadedBytes?: number;
  tracker?: string;
  category?: string;
  label?: string;
  isPrivate?: boolean;
  name?: string;
  /** Library the payload was imported into, when Media Intake recorded one. */
  libraryId?: string;
  /**
   * Minutes spent seeding. Undefined on both shipped engines — nothing records
   * it — which is why a time-based target evaluates to `unknown` rather than
   * being silently treated as zero.
   */
  seedMinutes?: number;
  /**
   * When the download finished. The anchor for `seedPolicy.maxAgeDays`, and
   * unlike `seedMinutes` both shipped engines report it — which is what makes an
   * age deadline enforceable where a seed-time target is not.
   */
  completedAt?: Date | null;

  /** Media Intake finished importing this torrent's content. */
  intakeImported?: boolean;
  /** The library copy or hardlink was verified to exist. */
  libraryCopyVerified?: boolean;
  /** The operator marked this torrent as never to be stopped automatically. */
  protectedFromRemoval?: boolean;
  /**
   * False while a schedule window forbids STARTING anything new. Deliberately
   * separate from a concurrency limit of zero: this declines to begin more work,
   * it does not stop work already in flight.
   */
  allowNewDownloads?: boolean;
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
  /**
   * The torrent's name, for display only — nothing branches on it.
   *
   * Carried because a decision is READ by a person deciding whether to enable
   * enforcement, and a 12-character hash prefix is not something anyone can
   * judge "should this be deleted?" against.
   */
  name?: string;
  engineId: string;
  currentOccupancy: OccupancyClass;
  desiredState: DesiredState;
  action: 'pause' | 'resume' | 'none' | 'remove_and_cleanup';
  reasonCode: string;
  messageKey: string;
  values?: Record<string, unknown>;
  score: number;
  protectedFromPause: boolean;
  policySource?: string;
  /**
   * The engine-wide rate ceiling this torrent's policy asks for.
   *
   * Carried on the decision rather than the plan because it is resolved through
   * the same scope chain as every other field, and the reconciler reads it from
   * the first decision — the engine has one ceiling, not one per torrent.
   */
  bandwidth?: {
    /**
     * Which policy set each rate, if any.
     *
     * The values alone cannot answer the question that matters: `null` is both
     * "a policy says unlimited" and "no policy mentioned bandwidth", and those
     * demand opposite behaviour — the first is an instruction to write, the
     * second is an instruction to leave the engine alone. `sources` carries the
     * winning policy id per field and is absent when nothing set it, which is
     * the same distinction `EffectivePolicy.sources` already draws.
     */
    sources?: { maxDownloadRateKbps?: string; maxUploadRateKbps?: string };
    maxDownloadRateKbps: number | null;
    maxUploadRateKbps: number | null;
    reserveDownloadPercent: number | null;
    reserveSeedPercent: number | null;
  };
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
  action: 'pause' | 'resume' | 'none' | 'remove_and_cleanup',
  reasonCode: string,
  values?: Record<string, unknown>,
): TorrentDecision {
  return {
    hash: t.hash,
    name: t.name,
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
    bandwidth: {
      sources: {
        maxDownloadRateKbps: t.policy.sources.maxDownloadRateKbps,
        maxUploadRateKbps: t.policy.sources.maxUploadRateKbps,
      },
      maxDownloadRateKbps: t.policy.maxDownloadRateKbps,
      maxUploadRateKbps: t.policy.maxUploadRateKbps,
      reserveDownloadPercent: t.policy.reserveDownloadBandwidthPercent,
      reserveSeedPercent: t.policy.reserveSeedBandwidthPercent,
    },
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
      || t.occupancy === 'excluded'
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

    /*
     * A seed that has met its target stops seeding, whatever the slot maths
     * says. Evaluated first because it is a different question from "is there
     * room": a torrent that has finished its obligation should stop even when
     * the engine is idle.
     */
    if (wantsSeed && active && t.policy.seedPolicy && !t.protectedFromPause) {
      const seedDecision = seedTargetDecision(t, limitations, engineId, cfg.now);
      if (seedDecision) {
        decisions.push(seedDecision);
        // A removal costs an action and frees the slot, exactly like a pause —
        // counting it as an occupied seed would let one aged torrent hold a slot
        // shut for the rest of the sweep.
        if (seedDecision.action === 'pause' || seedDecision.action === 'remove_and_cleanup') {
          actions++;
          continue;
        }
        // Not actioned (waiting, unknown, or an unsupported action): it keeps
        // its slot and is counted, but is not reconsidered below.
        seeds++; total++;
        continue;
      }
    }

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
    // A schedule window may forbid starting new downloads without touching the
    // ones already running.
    if (!wantsSeed && t.allowNewDownloads === false) {
      decisions.push(decide(t, 'paused', 'none', 'schedule_blocks_new_downloads'));
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

/**
 * What to do about a seed that may have met its target.
 *
 * Returns null when the policy has nothing to say yet, so the torrent falls
 * through to ordinary slot handling.
 *
 * Two refusals are deliberate. A target that cannot be EVALUATED — a time-based
 * one on an engine that does not report seed duration — never stops a torrent,
 * because guessing would either cut seeding short or run it forever. And the two
 * post-target actions that delete data are not performed here at all: removing a
 * torrent's payload has to go through the ownership and path-safety checks that
 * live in Media Intake, and a queue planner is the wrong place to acquire that
 * authority.
 */

/**
 * The facts a torrent presents to a policy's conditions.
 *
 * Deliberately lossy in one direction only: a field the planner does not have
 * is left ABSENT rather than defaulted, so the matcher can answer `unknown`.
 * Substituting a zero here would turn "we never measured the ratio" into "the
 * ratio is 0", and a rule reading `ratio < 1` would then match every torrent
 * the engine had not reported on.
 */
function seedFactsOf(t: PlannerTorrent): SeedFacts {
  const ageDays = t.completedAt
    ? (Date.now() - t.completedAt.getTime()) / 86_400_000
    : undefined;
  return {
    ratio: t.ratio,
    seedMinutes: t.seedMinutes,
    ageDays,
    sizeBytes: t.sizeBytes,
    tracker: t.tracker,
    category: t.category,
    label: t.label,
    isPrivate: t.isPrivate,
    name: t.name,
    libraryId: t.libraryId,
    // The planner already carries both of these under its own names.
    importCompleted: t.intakeImported,
    libraryCopyVerified: t.libraryCopyVerified,
    uploadedBytes: t.uploadedBytes,
  };
}

function seedTargetDecision(
  t: PlannerTorrent,
  limitations: SchedulerLimitation[],
  engineId: string,
  now: Date,
): TorrentDecision | null {
  const policy = t.policy.seedPolicy;
  if (!policy) return null;

  const verdict = evaluateSeedTarget(policy, seedFactsOf(t));

  /*
   * The deadline is checked BEFORE the target's own outcomes, on any verdict
   * that is not an outright success.
   *
   * Ordering matters in both directions. It has to come after `met`, or a
   * torrent that hit its ratio on day 31 would be cleaned up instead of running
   * the operator's chosen `afterTarget`. And it has to come before `unknown`,
   * because `unknown` is the single most likely state for a torrent that will
   * never finish — an engine that reports no ratio leaves the target
   * permanently unevaluable, and that is precisely the torrent an operator sets
   * a deadline for. Checking age only on `not_met` would exempt it forever.
   */
  if (verdict !== 'met' && !t.protectedFromRemoval) {
    const expired = evaluateSeedAgeDeadline(policy, { completedAt: t.completedAt }, now);
    if (expired === 'met') {
      return decide(t, 'removed', 'remove_and_cleanup', 'seed_age_deadline_reached', {
        maxAgeDays: policy.maxAgeDays,
        completedAt: t.completedAt?.toISOString(),
        ratio: t.ratio,
      });
    }
  }

  if (verdict === 'not_met') return null;

  if (verdict === 'unknown') {
    /*
     * Say so once per engine, and leave the torrent alone — but say the RIGHT
     * thing. This reported `no_seed_time_data` for every undecidable target,
     * which is correct only when the rule actually asks about seeding time. A
     * rule asking about the tracker got a sentence about seed duration, so the
     * operator could not tell which part of their policy was inert.
     */
    const unmeasurable = unmeasurableFields(policy.stopWhen)
      .filter((field) => field !== 'seed.seedMinutes');
    const code = unmeasurable.length ? 'unmeasurable_seed_condition' : 'no_seed_time_data';
    if (!limitations.some((l) => l.code === code)) {
      limitations.push({
        engineId,
        code,
        messageKey: `scheduler.limitation.${code}`,
        ...(unmeasurable.length ? { values: { fields: unmeasurable.join(', ') } } : {}),
      });
    }
    return decide(t, 'active', 'none', 'seed_target_unknown');
  }

  // Met. Anything that would take the payload away waits for the import to be
  // real first — the whole point of seeding past completion is usually that the
  // library copy is not safe yet.
  const destructive = policy.afterTarget === 'remove_torrent_keep_data'
    || policy.afterTarget === 'remove_torrent_and_staging_data';

  if (policy.requireImportCompleted && !t.intakeImported) {
    return decide(t, 'active', 'none', 'seed_target_waiting_for_import');
  }
  if (policy.requireLibraryCopyVerified && !t.libraryCopyVerified) {
    return decide(t, 'active', 'none', 'seed_target_waiting_for_library_copy');
  }

  /*
   * "Never stop this automatically" outranks the policy, and it has to be
   * checked BEFORE the destructive branch — below it, a protected torrent
   * would be removed and its staging files deleted, which is the one outcome
   * the flag exists to prevent. The age deadline already tests it for the same
   * reason.
   */
  if (t.protectedFromRemoval) {
    return decide(t, 'active', 'none', 'protected_from_removal');
  }

  if (destructive) {
    /*
     * Hand it to the same cleanup the age deadline uses, which is the same one
     * an operator gets when they remove an intake torrent and keep the library
     * copy: files are judged by CONTAINMENT — under a staging root they go,
     * under a library root they stay, unconditionally — and the engine is then
     * told `removeTorrent`, never `removeTorrentAndData`, so it cannot undo
     * that judgement with a rule that knows nothing about library roots.
     *
     * This used to answer `seed_target_removal_not_supported`. The machinery
     * existed and was already wired for the deadline; only the seed target was
     * refusing to reach it, which left a policy able to say "remove" and then
     * quietly do nothing.
     */
    /*
     * Its own reason code, not the one the pause branch uses.
     *
     * Both outcomes mean "the target was met", but one stops seeding and the
     * other deletes the payload, and they were sharing a code whose rendered
     * sentence read "would stop seeding" — so the operator reviewing a plan saw
     * the deletions described as pauses.
     */
    return decide(t, 'removed', 'remove_and_cleanup', 'seed_target_reached_removed', {
      afterTarget: policy.afterTarget,
      ratio: t.ratio,
    });
  }
  if (policy.afterTarget === 'leave_active') {
    return decide(t, 'active', 'none', 'seed_target_reached_left_active');
  }

  return decide(t, 'paused', 'pause', 'seed_target_reached', {
    mode: policy.mode,
    ratio: t.ratio,
  });
}

function reasonForUntouchable(o: OccupancyClass): string {
  switch (o) {
    case 'user_paused': return 'paused_by_user';
    case 'provider_paused': return 'paused_outside_scheduler';
    case 'parked': return 'parked_dead_swarm';
    case 'excluded': return 'excluded_by_operator';
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
