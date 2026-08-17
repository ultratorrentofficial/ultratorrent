import {
  evaluateSeedConditions,
  type SeedConditionNode,
  type SeedConditionVerdict,
  type SeedFacts,
} from './seed-conditions';

/**
 * Scheduling policy: what the operator wants, independent of any engine.
 *
 * ## The inherit / unlimited contract
 *
 * Every optional limit has three meanings, and conflating them is how a
 * scheduler ends up enforcing a limit nobody set:
 *
 *  - **absent** (`undefined`) — inherit from the next scope up.
 *  - **`null`** — explicitly UNLIMITED, and stops inheritance. A library that
 *    sets `maxConcurrentSeeds: null` overrides a global cap of 5; without a
 *    distinct value for this, "no limit here" and "ask my parent" are the same
 *    token and the override is impossible to express.
 *  - **a number** — that limit, at that scope.
 *
 * No magic numbers. `-1` never means unlimited outside a provider adapter, which
 * is the only place an engine's own convention belongs.
 */

/** Where a policy applies. Order here is not precedence — see {@link SCOPE_PRECEDENCE}. */
export type SchedulingPolicyScopeType =
  | 'global'
  | 'engine'
  | 'library'
  | 'category'
  | 'rss_rule'
  | 'torrent';

export interface SchedulingPolicyScope {
  type: SchedulingPolicyScopeType;
  /** Null for `global`; otherwise the id of the engine, library, rule, … */
  id: string | null;
}

/**
 * Most specific first. The planner resolves field by field, so a torrent-level
 * policy that sets only `maxConcurrentSeeds` inherits everything else — an
 * override is a patch, not a replacement.
 */
export const SCOPE_PRECEDENCE: SchedulingPolicyScopeType[] = [
  'torrent',
  'rss_rule',
  'category',
  'library',
  'engine',
  'global',
];

export type SeedingMode =
  | 'ratio'
  | 'time'
  | 'ratio_or_time'
  | 'ratio_and_time'
  | 'manual'
  | 'unlimited';

/**
 * What happens once a seed target is met.
 *
 * Five distinct outcomes, deliberately not one "delete". Two of them destroy
 * data and three do not, and an operator choosing between them is choosing
 * whether files survive.
 */
export type PostSeedAction =
  | 'pause'
  | 'stop'
  | 'remove_torrent_keep_data'
  | 'remove_torrent_and_staging_data'
  | 'leave_active';

export interface SeedingPolicy {
  mode: SeedingMode;
  targetRatio?: number;
  targetSeedMinutes?: number;
  /** Floors that apply even once a target is met — tracker obligations. */
  minimumSeedMinutes?: number;
  minimumRatio?: number;
  afterTarget: PostSeedAction;
  /** Block the post-target action until Media Intake finished importing. */
  requireImportCompleted?: boolean;
  /** Block it until the library copy/hardlink was verified. */
  requireLibraryCopyVerified?: boolean;
  /**
   * Give up on a target that is never going to be met: days since the torrent
   * COMPLETED, after which it is removed and its staging files deleted.
   *
   * A deadline, not a target — which is why it is a separate field rather than
   * another `SeedingMode`. `ratio_or_time` already expresses "stop at 2.0 or
   * 30 days", but both of its arms are *targets* whose success runs
   * `afterTarget`; this arm is the failure case, and the whole point is that it
   * ends differently from the ratio arm succeeding.
   *
   * It is also the only one of the two that can actually fire. `targetSeedMinutes`
   * reads `seedMinutes`, which neither shipped engine reports, so every
   * time-based target evaluates to `unknown` forever. Completion time is
   * recorded by both, so this is evaluable on any completed torrent.
   *
   * Measured from completion, so a torrent still downloading never ages out —
   * the clock is on the seeding obligation, not on how long ago the operator
   * asked for the file.
   *
   * Deliberately overrides `minimumRatio` / `minimumSeedMinutes`. Those floors
   * exist to keep a tracker obligation, and a floor that is unreachable would
   * otherwise pin the torrent forever — which is exactly the situation this
   * field is for.
   */
  maxAgeDays?: number;
  /**
   * When to stop seeding, as a list of conditions.
   *
   * This IS the target — "stop when ratio >= 2 OR 30 days have passed" — not a
   * filter over which torrents the policy covers. It supersedes `mode`,
   * `targetRatio` and `maxAgeDays`, which express the same idea in a fixed
   * shape that could only ever say one thing at a time.
   *
   * Absent means the legacy fields still decide, so a policy written before
   * this behaves exactly as it did.
   */
  stopWhen?: SeedConditionNode | null;
}

/** Default deadline offered when an operator turns the age rule on. */
export const DEFAULT_MAX_AGE_DAYS = 30;

export interface TorrentSchedulingPolicy {
  id: string;
  name: string;
  enabled: boolean;
  scope: SchedulingPolicyScope;

  maxConcurrentDownloads?: number | null;
  maxConcurrentSeeds?: number | null;
  maxTotalActive?: number | null;

  maxDownloadRateKbps?: number | null;
  maxUploadRateKbps?: number | null;

  reserveDownloadBandwidthPercent?: number;
  reserveSeedBandwidthPercent?: number;

  seedPolicy?: SeedingPolicy;
  activeScheduleId?: string | null;
}

/** The resolved answer for one torrent: every field decided, with its origin. */
export interface EffectivePolicy {
  maxConcurrentDownloads: number | null;
  maxConcurrentSeeds: number | null;
  maxTotalActive: number | null;
  maxDownloadRateKbps: number | null;
  maxUploadRateKbps: number | null;
  reserveDownloadBandwidthPercent: number | null;
  reserveSeedBandwidthPercent: number | null;
  seedPolicy: SeedingPolicy | null;
  activeScheduleId: string | null;
  /**
   * Which policy supplied each field.
   *
   * Kept because "why is this torrent queued" is answered by naming the policy,
   * not by restating the number. A queue reason that cannot cite its source is
   * not explainable.
   */
  sources: Partial<Record<keyof Omit<EffectivePolicy, 'sources'>, string>>;
}

/** The scopes one torrent belongs to, for matching policies against it. */
export interface PolicyMatchContext {
  torrentHash: string;
  engineId: string;
  libraryId?: string | null;
  categoryId?: string | null;
  rssRuleId?: string | null;
}

function matches(scope: SchedulingPolicyScope, ctx: PolicyMatchContext): boolean {
  switch (scope.type) {
    case 'global': return true;
    case 'engine': return scope.id === ctx.engineId;
    case 'library': return !!ctx.libraryId && scope.id === ctx.libraryId;
    case 'category': return !!ctx.categoryId && scope.id === ctx.categoryId;
    case 'rss_rule': return !!ctx.rssRuleId && scope.id === ctx.rssRuleId;
    case 'torrent': return scope.id?.toLowerCase() === ctx.torrentHash.toLowerCase();
    default: return false;
  }
}

const FIELDS = [
  'maxConcurrentDownloads',
  'maxConcurrentSeeds',
  'maxTotalActive',
  'maxDownloadRateKbps',
  'maxUploadRateKbps',
  'reserveDownloadBandwidthPercent',
  'reserveSeedBandwidthPercent',
  'seedPolicy',
  'activeScheduleId',
] as const;

/**
 * Resolve the policy that governs one torrent.
 *
 * Field by field, most specific scope first. Disabled policies are ignored
 * entirely — a disabled override must fall through to its parent rather than
 * pin the field to its own value.
 *
 * Where two enabled policies share a scope type, the one appearing first wins,
 * so the caller's ordering is the tie-break. Deterministic by construction: the
 * same inputs in the same order always produce the same answer.
 */
export function resolveEffectivePolicy(
  policies: TorrentSchedulingPolicy[],
  ctx: PolicyMatchContext,
): EffectivePolicy {
  const applicable = policies.filter((p) => p.enabled && matches(p.scope, ctx));

  const out: EffectivePolicy = {
    maxConcurrentDownloads: null,
    maxConcurrentSeeds: null,
    maxTotalActive: null,
    maxDownloadRateKbps: null,
    maxUploadRateKbps: null,
    reserveDownloadBandwidthPercent: null,
    reserveSeedBandwidthPercent: null,
    seedPolicy: null,
    activeScheduleId: null,
    sources: {},
  };

  for (const field of FIELDS) {
    for (const scopeType of SCOPE_PRECEDENCE) {
      const winner = applicable.find(
        (p) => p.scope.type === scopeType && p[field] !== undefined,
      );
      if (!winner) continue;
      // `null` is a decision (explicitly unlimited), so it stops the search
      // exactly as a number does. Only `undefined` keeps looking upward.
      (out as unknown as Record<string, unknown>)[field] = winner[field] ?? null;
      out.sources[field] = winner.id;
      break;
    }
  }

  return out;
}

/**
 * Has a seeding target been met?
 *
 * Unknown facts are NOT zero. A provider that cannot report seed time gives
 * `undefined`, and a `time` policy against it can never be satisfied — so the
 * answer is `unknown`, and the caller must decline to act rather than treat the
 * target as unmet (which would seed forever) or met (which would stop early).
 */
export type SeedTargetVerdict = 'met' | 'not_met' | 'unknown';

export function evaluateSeedTarget(
  policy: SeedingPolicy,
  facts: SeedFacts,
): SeedTargetVerdict {
  const { ratio, seedMinutes } = facts;

  /*
   * A condition list, when the policy has one, IS the target.
   *
   * It answers the same question the fixed fields did — has this seeded
   * enough? — but can say more than one thing: "ratio >= 2 OR 30 days", "ratio
   * >= 1 AND not a private tracker". The floors below are deliberately NOT
   * applied to it: a list that already names a ratio should not also be gated
   * by a separate minimum nobody can see from the list.
   */
  if (policy.stopWhen) return evaluateSeedConditions(policy.stopWhen, facts);

  // Obligations first: a floor that is not yet satisfied overrides any target.
  if (policy.minimumRatio !== undefined) {
    if (ratio === undefined) return 'unknown';
    if (ratio < policy.minimumRatio) return 'not_met';
  }
  if (policy.minimumSeedMinutes !== undefined) {
    if (seedMinutes === undefined) return 'unknown';
    if (seedMinutes < policy.minimumSeedMinutes) return 'not_met';
  }

  const ratioMet = (): SeedTargetVerdict => {
    if (policy.targetRatio === undefined) return 'unknown';
    if (ratio === undefined) return 'unknown';
    return ratio >= policy.targetRatio ? 'met' : 'not_met';
  };
  const timeMet = (): SeedTargetVerdict => {
    if (policy.targetSeedMinutes === undefined) return 'unknown';
    if (seedMinutes === undefined) return 'unknown';
    return seedMinutes >= policy.targetSeedMinutes ? 'met' : 'not_met';
  };

  switch (policy.mode) {
    case 'unlimited':
    case 'manual':
      return 'not_met'; // never auto-completes; only a person ends it
    case 'ratio':
      return ratioMet();
    case 'time':
      return timeMet();
    case 'ratio_or_time': {
      const r = ratioMet();
      const t = timeMet();
      if (r === 'met' || t === 'met') return 'met';
      // Either arm being unknown means the OR cannot be ruled out.
      if (r === 'unknown' || t === 'unknown') return 'unknown';
      return 'not_met';
    }
    case 'ratio_and_time': {
      const r = ratioMet();
      const t = timeMet();
      if (r === 'not_met' || t === 'not_met') return 'not_met';
      if (r === 'unknown' || t === 'unknown') return 'unknown';
      return 'met';
    }
    default:
      return 'unknown';
  }
}

/**
 * Has this torrent outlived its seeding deadline?
 *
 * Separate from {@link evaluateSeedTarget} because it answers a different
 * question. That one asks "did it succeed"; this asks "has it run out of time
 * trying", and the two produce opposite outcomes — success runs `afterTarget`,
 * expiry removes the torrent and deletes its staging copy.
 *
 * `unknown` when the torrent has not completed: the deadline is measured from
 * completion, so an incomplete torrent has no clock running yet. Returning
 * `not_met` there would be a lie of the same shape as treating a missing
 * `seedMinutes` as zero — it would read as "checked, still within the deadline"
 * when nothing was checked at all.
 */
export function evaluateSeedAgeDeadline(
  policy: SeedingPolicy,
  facts: { completedAt?: Date | null },
  now: Date,
): SeedTargetVerdict {
  if (policy.maxAgeDays === undefined) return 'not_met';
  // A non-positive deadline would expire everything the instant it completed.
  // Treat it as unset rather than as "delete immediately".
  if (!(policy.maxAgeDays > 0)) return 'not_met';
  if (!facts.completedAt) return 'unknown';

  const ageMs = now.getTime() - facts.completedAt.getTime();
  // A completion stamped in the future is a clock disagreement between host and
  // engine, not an aged torrent. Never let it expire anything.
  if (ageMs < 0) return 'not_met';
  return ageMs >= policy.maxAgeDays * 24 * 60 * 60 * 1000 ? 'met' : 'not_met';
}
