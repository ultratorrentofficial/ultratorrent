/**
 * Media health scoring.
 *
 * A single number an operator can act on, plus the reasons behind it. Pure by
 * design: the score is the part that must be explainable and stable, and mixing
 * it with queries would make it untestable and tempt callers to compute it
 * slightly differently in three places.
 *
 * **Only facts a query can decide.** "Broken file" and "missing episode still
 * looks wrong" need to stat disk or decode an image; a score that waited on I/O
 * could not be rendered in a list, and one that guessed would be worse than
 * none. The same boundary the Issues chips already use.
 */

/** What the checks below need to know about one item. */
export interface HealthFacts {
  matched: boolean;
  hasMetadata: boolean;
  hasArtwork: boolean;
  hasSubtitles: boolean;
  isDuplicate: boolean;
  /** Measured by mediainfo rather than guessed from the filename. */
  hasMeasuredTech: boolean;
  /** The file sits in a scene release folder rather than an organised path. */
  unorganised: boolean;
}

export type HealthStatus = 'healthy' | 'attention' | 'problem' | 'unknown';

export interface HealthCheck {
  id: string;
  /** How much of the 100 this check is worth. */
  weight: number;
  passed: boolean;
  /** Only a failure carries one, so a healthy item has an empty reason list. */
  reason?: string;
}

export interface HealthResult {
  score: number;
  status: HealthStatus;
  checks: HealthCheck[];
  reasons: string[];
}

/*
 * Weights.
 *
 * Identity first: an unmatched item is not "slightly unhealthy", it is an item
 * the platform cannot reason about at all — no metadata, no artwork and no
 * correct name can follow from it, so it carries the largest single weight and
 * failing it alone drops an item below the healthy band.
 *
 * Subtitles are weighted lowest deliberately. Plenty of libraries neither want
 * nor need them, and scoring them like metadata would paint a perfectly good
 * library amber and train operators to ignore the colour.
 */
const WEIGHTS = {
  matched: 35,
  metadata: 25,
  artwork: 15,
  naming: 10,
  tech: 8,
  subtitles: 7,
} as const;

/** Below this an item is amber; below the second, red. */
export const HEALTHY_AT = 85;
export const PROBLEM_BELOW = 55;

export function scoreItem(facts: HealthFacts): HealthResult {
  const checks: HealthCheck[] = [
    {
      id: 'matched', weight: WEIGHTS.matched, passed: facts.matched && !facts.isDuplicate,
      reason: facts.isDuplicate ? 'duplicate' : facts.matched ? undefined : 'unmatched',
    },
    {
      id: 'metadata', weight: WEIGHTS.metadata, passed: facts.hasMetadata,
      reason: facts.hasMetadata ? undefined : 'missing_metadata',
    },
    {
      id: 'artwork', weight: WEIGHTS.artwork, passed: facts.hasArtwork,
      reason: facts.hasArtwork ? undefined : 'missing_artwork',
    },
    {
      id: 'naming', weight: WEIGHTS.naming, passed: !facts.unorganised,
      reason: facts.unorganised ? 'unorganised_path' : undefined,
    },
    {
      id: 'tech', weight: WEIGHTS.tech, passed: facts.hasMeasuredTech,
      reason: facts.hasMeasuredTech ? undefined : 'not_analyzed',
    },
    {
      id: 'subtitles', weight: WEIGHTS.subtitles, passed: facts.hasSubtitles,
      reason: facts.hasSubtitles ? undefined : 'missing_subtitles',
    },
  ];

  const earned = checks.reduce((sum, c) => sum + (c.passed ? c.weight : 0), 0);
  const total = checks.reduce((sum, c) => sum + c.weight, 0);
  const score = Math.round((earned / total) * 100);

  return {
    score,
    status: statusFor(score),
    checks,
    reasons: checks.filter((c) => !c.passed && c.reason).map((c) => c.reason!),
  };
}

export function statusFor(score: number): HealthStatus {
  if (score >= HEALTHY_AT) return 'healthy';
  if (score >= PROBLEM_BELOW) return 'attention';
  return 'problem';
}

/**
 * Roll a set of scores into one.
 *
 * The **mean**, not the minimum: a 49-episode show with one unmatched file is
 * not in the same state as one where every episode is unmatched, and a rollup
 * that reported the worst member would paint almost every real library red and
 * make the number useless for deciding where to spend effort.
 *
 * An empty set is `unknown` rather than 100 — a season with no episodes has not
 * passed anything, and scoring it perfect would hide it from exactly the
 * operator looking for gaps.
 */
export function rollup(scores: number[]): { score: number; status: HealthStatus } {
  if (!scores.length) return { score: 0, status: 'unknown' };
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const score = Math.round(mean);
  return { score, status: statusFor(score) };
}

/**
 * A path that is a scene release rather than an organised location.
 *
 * The same episode-marker test the browser's grouping uses: a folder naming one
 * episode is a torrent's extract directory, which means the file was never
 * filed into `Show/Season NN/`.
 */
export function isUnorganisedPath(path: string): boolean {
  const parent = path.split('/').slice(-2, -1)[0] ?? '';
  return /\bs\d{1,2}[\s._-]*e\d{1,3}\b/i.test(parent);
}
