/**
 * A deterministic, explainable priority score.
 *
 * Explainable is the requirement, not merely a nicety: the queue view has to
 * answer "why is this torrent waiting while that one runs". A single opaque
 * number cannot, so every contribution is recorded with its own code and value
 * and the score is their sum. No machine learning, no user-supplied
 * expressions, no `eval` — the inputs are typed facts and fixed weights.
 */

export type PriorityBand = 'critical' | 'high' | 'normal' | 'low' | 'fallback';

export interface PriorityReason {
  code: string;
  contribution: number;
  messageKey: string;
  values?: Record<string, unknown>;
}

export interface TorrentPriorityDecision {
  torrentHash: string;
  score: number;
  band: PriorityBand;
  reasons: PriorityReason[];
}

export interface PriorityFacts {
  torrentHash: string;
  /** Operator's explicit priority, if set. Highest-weight single input. */
  userPriority?: 'high' | 'normal' | 'low';
  forceStarted?: boolean;
  /** Protected torrents are not prioritised — protection governs pausing. */
  protectedFromPause?: boolean;
  /** 0..1 */
  progress: number;
  /** Minutes since it was added. */
  ageMinutes?: number;
  /** Minutes it has been waiting for a slot. */
  waitingMinutes?: number;
  /** Tracker-reported seeders; `undefined` when unknown, never assumed 0. */
  seeders?: number;
  isPrivate?: boolean;
  /** Came from a wanted/missing-episode search rather than a browse. */
  wanted?: boolean;
  /** An upgrade over something already in the library. */
  upgrade?: boolean;
  /** Media Intake is waiting on this torrent to finish. */
  intakePending?: boolean;
}

/**
 * Weights.
 *
 * Deliberately coarse and few. A dense weighting table looks precise and is
 * impossible to reason about when an operator asks why one torrent outranked
 * another; these are chosen so a human can add them up in their head.
 */
const W = {
  forceStart: 1000,
  userHigh: 400,
  userLow: -400,
  wanted: 150,
  upgrade: 60,
  intakePending: 120,
  private: 80,
  /** Nearly-done torrents finish and free their slot; favour them mildly. */
  progressMax: 100,
  /** Waiting a long time should eventually win, but never beat an explicit choice. */
  waitingPerHourMax: 90,
  /** A swarm with no seeders cannot progress — deprioritise, do not exclude. */
  noSeeders: -200,
} as const;

function band(score: number): PriorityBand {
  if (score >= 800) return 'critical';
  if (score >= 300) return 'high';
  if (score >= 0) return 'normal';
  if (score >= -300) return 'low';
  return 'fallback';
}

/** Score one torrent. Pure: same facts always give the same decision. */
export function scoreTorrent(facts: PriorityFacts): TorrentPriorityDecision {
  const reasons: PriorityReason[] = [];
  const add = (code: string, contribution: number, values?: Record<string, unknown>) => {
    if (contribution === 0) return;
    reasons.push({ code, contribution, messageKey: `scheduler.priority.${code}`, values });
  };

  if (facts.forceStarted) add('force_started', W.forceStart);

  if (facts.userPriority === 'high') add('user_priority_high', W.userHigh);
  else if (facts.userPriority === 'low') add('user_priority_low', W.userLow);

  if (facts.wanted) add('wanted_item', W.wanted);
  if (facts.upgrade) add('quality_upgrade', W.upgrade);
  if (facts.intakePending) add('intake_waiting', W.intakePending);
  if (facts.isPrivate) add('private_tracker', W.private);

  // Progress: 0 at the start, full weight at completion.
  const progress = Math.max(0, Math.min(1, facts.progress));
  add('progress', Math.round(progress * W.progressMax), { percent: Math.round(progress * 100) });

  if (facts.waitingMinutes && facts.waitingMinutes > 0) {
    // Saturating, so a torrent queued for a week cannot outrank a force-start.
    const hours = facts.waitingMinutes / 60;
    const contribution = Math.round(Math.min(W.waitingPerHourMax, hours * 10));
    add('waiting', contribution, { minutes: facts.waitingMinutes });
  }

  // Only when the number is KNOWN. Unknown seeders must not be read as zero —
  // that would push every torrent on a provider without seeder reporting to the
  // bottom of the queue.
  if (facts.seeders !== undefined && facts.seeders <= 0) {
    add('no_seeders', W.noSeeders);
  }

  const score = reasons.reduce((sum, r) => sum + r.contribution, 0);
  return { torrentHash: facts.torrentHash, score, band: band(score), reasons };
}

/**
 * Deterministic ordering, highest priority first.
 *
 * The tie-breaks matter more than the score for stability. Preferring an
 * already-active torrent over an inactive one at equal score is what stops the
 * planner swapping two equally-ranked torrents on every sweep — churn that
 * costs real transfer time and teaches operators to distrust the scheduler.
 */
export interface OrderableTorrent {
  decision: TorrentPriorityDecision;
  currentlyActive: boolean;
  addedAt?: Date | null;
}

export function orderByPriority<T extends OrderableTorrent>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (b.decision.score !== a.decision.score) return b.decision.score - a.decision.score;
    // Incumbency: reduces churn at equal score.
    if (a.currentlyActive !== b.currentlyActive) return a.currentlyActive ? -1 : 1;
    const at = a.addedAt ? a.addedAt.getTime() : Number.MAX_SAFE_INTEGER;
    const bt = b.addedAt ? b.addedAt.getTime() : Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt; // earlier added first
    // Final, total tie-break so ordering is stable across processes.
    return a.decision.torrentHash.localeCompare(b.decision.torrentHash);
  });
}
