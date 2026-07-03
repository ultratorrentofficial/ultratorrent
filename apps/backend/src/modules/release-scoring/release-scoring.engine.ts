import { parseTorrentName } from '../rss/torrent-name-parser';

export interface ReleaseScoreInput {
  /** The raw release/torrent name (parsed if structured fields are absent). */
  title: string;
  preferredResolution?: string; // e.g. '1080p'
  preferredCodec?: string; // e.g. 'x265'
  preferredSources?: string[]; // e.g. ['bluray','web']
  preferredGroups?: string[];
  avoidedGroups?: string[];
  excludedTerms?: string[];
  seeders?: number;
  trackerHealth?: 'healthy' | 'degraded' | 'dead';
  /** True when an equal-or-better copy already exists. */
  duplicateRisk?: boolean;
}

export type ReleaseDecision = 'download' | 'review' | 'skip' | 'reject';

export interface ReleaseScoreResult {
  score: number; // 0–100
  decision: ReleaseDecision;
  reasons: string[];
  warnings: string[];
  parsed: {
    resolution: string | null;
    codec: string | null;
    source: string | null;
    releaseGroup: string | null;
  };
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Pure, explainable release scoring. Given a parsed release + the operator's
 * preferences, returns a 0–100 score with the exact reasons and warnings that
 * produced it, plus a decision recommendation. No IO, fully deterministic.
 */
export function scoreRelease(input: ReleaseScoreInput): ReleaseScoreResult {
  const parsed = parseTorrentName(input.title);
  const resolution = parsed.resolution ?? null;
  const codec = parsed.codec ?? null;
  const source = parsed.source ?? null;
  const releaseGroup = parsed.releaseGroup ?? null;

  const reasons: string[] = [];
  const warnings: string[] = [];
  let score = 50;
  const add = (delta: number, reason: string) => { score += delta; reasons.push(`${delta >= 0 ? '+' : ''}${delta} ${reason}`); };

  // Hard reject on excluded terms.
  const lower = input.title.toLowerCase();
  const hit = (input.excludedTerms ?? []).find((t) => t && lower.includes(t.toLowerCase()));
  if (hit) {
    warnings.push(`excluded term "${hit}" present`);
    return { score: 0, decision: 'reject', reasons: [`-50 excluded term "${hit}"`], warnings, parsed: { resolution, codec, source, releaseGroup } };
  }

  // Resolution preference.
  if (input.preferredResolution) {
    if (!resolution) warnings.push('resolution could not be determined');
    else if (resolution.toLowerCase() === input.preferredResolution.toLowerCase()) add(20, `resolution matches ${input.preferredResolution}`);
    else add(-12, `resolution ${resolution} ≠ preferred ${input.preferredResolution}`);
  }

  // Codec preference.
  if (input.preferredCodec) {
    if (codec && codec.toLowerCase().includes(input.preferredCodec.toLowerCase())) add(10, `codec matches ${input.preferredCodec}`);
    else if (codec) add(-6, `codec ${codec} ≠ preferred ${input.preferredCodec}`);
  }

  // Source preference (ordered list; earlier = better).
  if (input.preferredSources?.length && source) {
    const idx = input.preferredSources.findIndex((s) => source.toLowerCase().includes(s.toLowerCase()));
    if (idx === 0) add(15, `top-preferred source (${source})`);
    else if (idx > 0) add(8, `acceptable source (${source})`);
    else add(-10, `non-preferred source (${source})`);
  }

  // Release group.
  if (releaseGroup) {
    if ((input.avoidedGroups ?? []).some((g) => g.toLowerCase() === releaseGroup.toLowerCase())) add(-25, `avoided release group ${releaseGroup}`);
    else if ((input.preferredGroups ?? []).some((g) => g.toLowerCase() === releaseGroup.toLowerCase())) add(12, `preferred release group ${releaseGroup}`);
  }

  // Seeders (swarm health).
  if (input.seeders != null) {
    if (input.seeders === 0) { add(-25, 'no seeders'); warnings.push('zero seeders — may never complete'); }
    else if (input.seeders < 5) add(-10, `low seeders (${input.seeders})`);
    else if (input.seeders >= 50) add(15, `healthy swarm (${input.seeders} seeders)`);
    else add(5, `adequate seeders (${input.seeders})`);
  }

  // Tracker health.
  if (input.trackerHealth === 'dead') { add(-20, 'tracker dead'); warnings.push('tracker reported dead'); }
  else if (input.trackerHealth === 'degraded') add(-8, 'tracker degraded');
  else if (input.trackerHealth === 'healthy') add(5, 'tracker healthy');

  // Duplicate risk.
  if (input.duplicateRisk) { add(-30, 'duplicate of an existing copy'); warnings.push('an equal-or-better copy already exists'); }

  score = clamp(score);
  const decision: ReleaseDecision = score >= 70 ? 'download' : score >= 40 ? 'review' : 'skip';
  return { score, decision, reasons, warnings, parsed: { resolution, codec, source, releaseGroup } };
}
