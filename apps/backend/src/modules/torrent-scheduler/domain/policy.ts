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
}

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
  facts: { ratio?: number; seedMinutes?: number },
): SeedTargetVerdict {
  const { ratio, seedMinutes } = facts;

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
