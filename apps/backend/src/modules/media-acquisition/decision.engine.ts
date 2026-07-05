import { MODULE_IDS } from '@ultratorrent/shared';

export const MEDIA_ACQUISITION_MODULE_ID = MODULE_IDS.MEDIA_ACQUISITION_INTELLIGENCE;

export type AcquisitionDecision =
  | 'download'
  | 'skip'
  | 'wait'
  | 'hold_for_approval'
  | 'upgrade_existing'
  | 'replace_existing'
  | 'manual_review';

export interface DecisionProfile {
  minimumScore: number;
  approvalScore: number;
  excludedTerms: string[];
  requiredTerms: string[];
  allowUpgrades: boolean;
  approvalRequired: boolean; // profile forces approval
  /** Hold an acceptable-but-mediocre release, waiting for a better one. */
  waitForBetter: boolean;
  /** When waitForBetter is on, a new download scoring below this waits. */
  waitUntilScore: number;
}

export interface DecisionSignals {
  /** From the release-scoring engine (0–100 + reasons/warnings + its own decision). */
  score: { value: number; warnings: string[]; rejected: boolean };
  watchlist: { matched: boolean; ambiguous?: boolean };
  library: { needed: boolean; owned: boolean; newIsBetter?: boolean; ambiguous?: boolean };
  duplicate: { level: 'low' | 'medium' | 'high' };
  storage: { ok: boolean; nearThreshold?: boolean };
  /** File size in bytes, when known — large files can trigger approval. */
  sizeBytes?: number;
  /** Lowercased release title, for excluded/required term checks. */
  titleLower: string;
}

export interface TraceStep {
  step: string;
  status: 'success' | 'warning' | 'blocked' | 'info';
  reason: string;
  score?: number;
  decision?: AcquisitionDecision;
}

export interface DecisionResult {
  decision: AcquisitionDecision;
  reason: string;
  confidence: number; // 0–100
  requiresApproval: boolean;
  trace: TraceStep[];
}

const LARGE_FILE_BYTES = 40 * 1024 * 1024 * 1024; // 40 GB

/**
 * Pure, explainable acquisition decision. Given gathered signals + the active
 * profile, returns the decision, a human reason, a confidence, whether approval
 * is required, and a full step-by-step trace. No IO — fully deterministic and
 * unit-testable. Never performs or recommends a direct file deletion.
 */
export function decide(signals: DecisionSignals, profile: DecisionProfile): DecisionResult {
  const trace: TraceStep[] = [];
  const add = (s: TraceStep) => trace.push(s);
  let confidence = 50;

  // 1) Excluded terms → hard skip.
  const excluded = profile.excludedTerms.find((t) => t && signals.titleLower.includes(t.toLowerCase()));
  if (excluded) {
    add({ step: 'excluded_terms', status: 'blocked', reason: `excluded term "${excluded}" present` });
    return final('skip', `Blocked by excluded term "${excluded}"`, 95, false, trace, add);
  }
  // Required terms must all be present.
  const missingRequired = profile.requiredTerms.find((t) => t && !signals.titleLower.includes(t.toLowerCase()));
  if (missingRequired) {
    add({ step: 'required_terms', status: 'blocked', reason: `missing required term "${missingRequired}"` });
    return final('skip', `Missing required term "${missingRequired}"`, 85, false, trace, add);
  }

  // 2) Scoring engine outright rejected (e.g. CAM) → skip.
  if (signals.score.rejected) {
    add({ step: 'release_scoring', status: 'blocked', reason: 'release scoring rejected the release', score: signals.score.value });
    return final('skip', 'Release scoring rejected this release', 90, false, trace, add);
  }
  add({ step: 'release_scoring', status: 'success', reason: `release score ${signals.score.value}`, score: signals.score.value });
  confidence += signals.score.value >= profile.minimumScore ? 10 : -15;

  // 3) Ambiguity → manual review.
  if (signals.library.ambiguous || signals.watchlist.ambiguous) {
    add({ step: 'ambiguity', status: 'warning', reason: 'multiple library/watchlist matches — needs a human' });
    return final('manual_review', 'Ambiguous match across library/watchlist', 35, true, trace, add);
  }

  // 4) Want it at all? (watchlist match OR a genuine library gap)
  if (!signals.watchlist.matched && !signals.library.needed && !signals.library.owned) {
    add({ step: 'desire', status: 'info', reason: 'not on a watchlist and not a known library gap' });
    return final('skip', 'Not wanted (no watchlist match, no library gap)', 70, false, trace, add);
  }
  if (signals.watchlist.matched) { add({ step: 'watchlist_match', status: 'success', reason: 'matched an active watchlist item' }); confidence += 20; }

  // 5) Already owned?
  if (signals.library.owned && !signals.library.needed) {
    if (signals.library.newIsBetter && profile.allowUpgrades && signals.duplicate.level !== 'high') {
      add({ step: 'library_need', status: 'info', reason: 'owned, but this release is meaningfully better' });
      const upg = signals.score.value < profile.approvalScore || signals.duplicate.level === 'medium';
      return final('upgrade_existing', 'Quality upgrade over the owned copy', 70, upg || profile.approvalRequired, trace, add);
    }
    add({ step: 'library_need', status: 'info', reason: 'already owned in equal/better quality' });
    return final('skip', 'Already owned in equal or better quality', 80, false, trace, add);
  }
  if (signals.library.needed) { add({ step: 'library_need', status: 'success', reason: 'content is missing from the library' }); confidence += 15; }

  // 6) Below the minimum score → skip.
  if (signals.score.value < profile.minimumScore) {
    add({ step: 'quality_gate', status: 'blocked', reason: `score ${signals.score.value} < minimum ${profile.minimumScore}` });
    return final('skip', `Below minimum score (${signals.score.value} < ${profile.minimumScore})`, 75, false, trace, add);
  }

  // 7) Storage hard-block.
  if (!signals.storage.ok) {
    add({ step: 'storage', status: 'blocked', reason: 'storage rule blocks acquisition' });
    return final('skip', 'Storage rules block this acquisition', 80, false, trace, add);
  }

  // 7b) Wait-for-better: a fresh, acceptable-but-mediocre release is held so a
  // higher-quality one can be preferred instead of grabbing this one now.
  if (profile.waitForBetter && !signals.library.owned && signals.score.value < profile.waitUntilScore) {
    add({ step: 'wait_policy', status: 'info', reason: `score ${signals.score.value} < wait cutoff ${profile.waitUntilScore}` });
    return final('wait', `Waiting for a better release (score ${signals.score.value} < ${profile.waitUntilScore})`, 60, false, trace, add);
  }

  // 8) Approval triggers → hold.
  const approvalReasons: string[] = [];
  if (profile.approvalRequired) approvalReasons.push('profile requires approval');
  if (signals.score.value < profile.approvalScore) approvalReasons.push(`score ${signals.score.value} < approval ${profile.approvalScore}`);
  if (signals.duplicate.level === 'medium' || signals.duplicate.level === 'high') approvalReasons.push(`duplicate risk ${signals.duplicate.level}`);
  if ((signals.sizeBytes ?? 0) > LARGE_FILE_BYTES) approvalReasons.push('unusually large file');
  if (signals.storage.nearThreshold) approvalReasons.push('storage near threshold');
  if (confidence < 40) approvalReasons.push('low match confidence');

  confidence = Math.max(0, Math.min(100, confidence));
  if (approvalReasons.length) {
    add({ step: 'approval', status: 'warning', reason: approvalReasons.join('; ') });
    return final('hold_for_approval', `Held for approval: ${approvalReasons.join('; ')}`, confidence, true, trace, add);
  }

  // 9) Download.
  add({ step: 'duplicate_risk', status: 'success', reason: `duplicate risk ${signals.duplicate.level}` });
  return final('download', 'Missing/wanted content with a release above thresholds', confidence, false, trace, add);
}

function final(
  decision: AcquisitionDecision,
  reason: string,
  confidence: number,
  requiresApproval: boolean,
  trace: TraceStep[],
  add: (s: TraceStep) => void,
): DecisionResult {
  add({ step: 'final_decision', status: 'success', reason, decision });
  return { decision, reason, confidence: Math.max(0, Math.min(100, confidence)), requiresApproval, trace };
}
