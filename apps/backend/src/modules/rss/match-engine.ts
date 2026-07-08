/**
 * Intelligent RSS match engine.
 *
 * Pure, dependency-free logic so it is trivially unit-testable. Evaluates an
 * ordered list of match candidates against an RSS item and stops at the first
 * candidate that matches (highest preference = lowest priorityOrder).
 */

export type MatchType =
  | 'exact_text'
  | 'contains_text'
  | 'regex'
  | 'wildcard'
  | 'smart_episode_match'
  | 'smart_movie_match'
  | 'fuzzy_match';

export interface QualityRules {
  quality?: string;
  source?: string;
  codec?: string;
  resolution?: string;
  season?: number;
  episode?: number;
  year?: number;
}

export interface SizeRules {
  minBytes?: number;
  maxBytes?: number;
}

export interface FeedScope {
  feedIds?: string[];
}

export interface MatchCandidateInput {
  id: string;
  name: string;
  priorityOrder: number;
  enabled: boolean;
  matchType: MatchType;
  pattern?: string | null;
  requiredTerms?: string[];
  excludedTerms?: string[];
  qualityRules?: QualityRules;
  sizeRules?: SizeRules;
  feedScope?: FeedScope;
}

export interface ItemContext {
  title: string;
  feedId?: string;
  sizeBytes?: number | null;
}

export interface CheckResult {
  label: string;
  passed: boolean;
  detail: string;
}

export type CandidateOutcome = 'matched' | 'failed' | 'skipped' | 'disabled';

export interface CandidateResult {
  candidateId: string;
  name: string;
  priorityOrder: number;
  matchType: MatchType;
  result: CandidateOutcome;
  reason: string;
  checks: CheckResult[];
}

export interface ParsedRelease {
  resolution?: string;
  source?: string;
  codec?: string;
  season?: number;
  episode?: number;
  year?: number;
  languages: string[];
  repack: boolean;
  proper: boolean;
  badQuality: string[];
}

export interface ListEvaluation {
  matched: boolean;
  matchedCandidateId: string | null;
  matchedCandidatePriority: number | null;
  action: 'download' | 'none';
  candidates: CandidateResult[];
  parsed: ParsedRelease;
}

const FUZZY_THRESHOLD = 0.7;

// --- normalization -------------------------------------------------------

/** Lowercase, fold separators (._-) to spaces, strip punctuation, collapse. */
export function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[._\-]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compact form for token-equality comparisons (no spaces). */
function compact(input: string): string {
  return normalize(input).replace(/\s+/g, '');
}

function tokens(input: string): string[] {
  return normalize(input).split(' ').filter(Boolean);
}

// --- release metadata detection -----------------------------------------

const SOURCE_ALIASES: Array<[RegExp, string]> = [
  [/web[\s._-]?dl/i, 'webdl'],
  [/webrip/i, 'webrip'],
  [/blu[\s._-]?ray|bdrip|brrip|bdmux/i, 'bluray'],
  [/remux/i, 'remux'],
  [/hdtv/i, 'hdtv'],
  [/dvdrip|dvd/i, 'dvd'],
  [/hdrip/i, 'hdrip'],
  [/\bweb\b/i, 'web'],
];

const CODEC_ALIASES: Array<[RegExp, string]> = [
  [/x265|h[\s.]?265|hevc/i, 'x265'],
  [/x264|h[\s.]?264|avc/i, 'x264'],
  [/av1/i, 'av1'],
  [/xvid/i, 'xvid'],
];

const BAD_QUALITY =
  /\b(cam|ts|telesync|telecine|hdcam|hdts|screener|scr|workprint|dubbed|hardsub|hardcoded|hc)\b/gi;

const LANGUAGES =
  /\b(multi|vostfr|truefrench|french|german|ita|italian|spanish|dual|nordic|dutch)\b/gi;

export function parseRelease(title: string): ParsedRelease {
  const out: ParsedRelease = { languages: [], repack: false, proper: false, badQuality: [] };

  const res = /\b(2160p|4k|uhd|1080p|720p|480p)\b/i.exec(title);
  if (res) {
    const r = res[1].toLowerCase();
    out.resolution = r === '4k' || r === 'uhd' ? '2160p' : r;
  }

  for (const [re, canon] of SOURCE_ALIASES) {
    if (re.test(title)) {
      out.source = canon;
      break;
    }
  }
  for (const [re, canon] of CODEC_ALIASES) {
    if (re.test(title)) {
      out.codec = canon;
      break;
    }
  }

  // Episode detection across common formats.
  let m = /s(\d{1,2})[\s._-]*e(\d{1,3})/i.exec(title);
  if (!m) m = /\b(\d{1,2})x(\d{1,3})\b/i.exec(title);
  if (!m) m = /season[\s._-]*(\d{1,2})[\s._-]*episode[\s._-]*(\d{1,3})/i.exec(title);
  if (m) {
    out.season = parseInt(m[1], 10);
    out.episode = parseInt(m[2], 10);
  }

  const year = /\b(19|20)\d{2}\b/.exec(title);
  if (year) out.year = parseInt(year[0], 10);

  const langs = title.match(LANGUAGES);
  if (langs) out.languages = [...new Set(langs.map((l) => l.toLowerCase()))];

  out.repack = /\brepack\b/i.test(title);
  out.proper = /\bproper\b/i.test(title);
  const bad = title.match(BAD_QUALITY);
  if (bad) out.badQuality = [...new Set(bad.map((b) => b.toLowerCase()))];

  return out;
}

// --- codec equivalence ---------------------------------------------------

function codecEquivalent(a: string, b: string): boolean {
  const norm = (c: string) => {
    const x = compact(c);
    if (['x265', 'h265', 'hevc'].includes(x)) return 'x265';
    if (['x264', 'h264', 'avc'].includes(x)) return 'x264';
    return x;
  };
  return norm(a) === norm(b);
}

function sourceEquivalent(a: string, b: string): boolean {
  const norm = (s: string) => {
    const x = compact(s);
    if (['webdl', 'web'].includes(x)) return 'webdl';
    if (['bluray', 'bdrip', 'brrip'].includes(x)) return 'bluray';
    return x;
  };
  return norm(a) === norm(b);
}

// --- core match-type evaluation -----------------------------------------

function coreMatch(
  candidate: MatchCandidateInput,
  ctx: ItemContext,
  parsed: ParsedRelease,
): CheckResult {
  const title = ctx.title;
  const pattern = candidate.pattern ?? '';
  const qr = candidate.qualityRules ?? {};

  switch (candidate.matchType) {
    case 'exact_text': {
      const passed = normalize(title) === normalize(pattern);
      return { label: 'exact text', passed, detail: passed ? 'exact match' : 'title does not equal pattern' };
    }
    case 'contains_text': {
      // Token-AND: the title must contain EVERY word of the pattern (each as a
      // normalized substring), in any order — not one contiguous run. So
      // "Agent Kim Reactivated XviD-AFG" still matches
      // "Agent Kim Reactivated S01E03 XviD-AFG": the episode token in the
      // middle no longer breaks it.
      //
      // Numeric words are the exception: they must match a WHOLE title token,
      // not a loose substring. Otherwise a hyphenated numeric show title like
      // "9-1-1" (which normalizes to the words "9","1","1") matches virtually
      // every release, since "9"/"1" appear inside "S09E07", "1080p", etc. —
      // dissolving the title constraint entirely (see 9-1-1 over-match).
      const normTitle = normalize(title);
      const titleTokens = new Set(tokens(title));
      const words = tokens(pattern);
      if (words.length === 0) {
        return { label: 'contains text', passed: false, detail: 'empty pattern' };
      }
      const isNumeric = (w: string) => /^\d+$/.test(w);
      const missing = words.filter((w) =>
        isNumeric(w) ? !titleTokens.has(w) : !normTitle.includes(w),
      );
      const passed = missing.length === 0;
      return {
        label: 'contains text',
        passed,
        detail: passed
          ? `contains all ${words.length} word(s)`
          : `missing word(s): ${missing.join(', ')}`,
      };
    }
    case 'regex': {
      let re: RegExp;
      try {
        re = new RegExp(pattern, 'i');
      } catch {
        return { label: 'regex', passed: false, detail: 'invalid regular expression' };
      }
      const passed = re.test(title);
      return { label: 'regex', passed, detail: passed ? 'regex matched' : 'regex did not match' };
    }
    case 'wildcard': {
      const re = wildcardToRegex(pattern);
      const passed = re.test(title);
      return { label: 'wildcard', passed, detail: passed ? 'wildcard matched' : 'wildcard did not match' };
    }
    case 'smart_episode_match': {
      const titleOk = !pattern || normalize(title).includes(normalize(pattern));
      if (!titleOk) return { label: 'smart episode', passed: false, detail: `show title “${pattern}” not found` };
      if (qr.season != null && parsed.season !== qr.season)
        return { label: 'smart episode', passed: false, detail: `season ${qr.season} not found (got ${parsed.season ?? 'none'})` };
      if (qr.episode != null && parsed.episode !== qr.episode)
        return { label: 'smart episode', passed: false, detail: `episode ${qr.episode} not found (got ${parsed.episode ?? 'none'})` };
      return { label: 'smart episode', passed: true, detail: `matched S${qr.season}E${qr.episode}` };
    }
    case 'smart_movie_match': {
      const titleOk = !pattern || normalize(title).includes(normalize(pattern));
      if (!titleOk) return { label: 'smart movie', passed: false, detail: `movie title “${pattern}” not found` };
      if (qr.year != null && parsed.year !== qr.year)
        return { label: 'smart movie', passed: false, detail: `year ${qr.year} not found (got ${parsed.year ?? 'none'})` };
      return { label: 'smart movie', passed: true, detail: 'movie matched' };
    }
    case 'fuzzy_match': {
      // If the pattern implies an episode, require it (validated structurally,
      // not by token overlap, since titles encode it as S02E05 etc.).
      const pep = parseRelease(pattern);
      if (pep.season != null && (parsed.season !== pep.season || parsed.episode !== pep.episode)) {
        return { label: 'fuzzy', passed: false, detail: `episode S${pep.season}E${pep.episode} not found` };
      }
      // Drop episode/season filler tokens so the ratio reflects the title words.
      const episodeToken = /^(season|episode|ep|s\d{1,2}e\d{1,3}|\d{1,3})$/;
      const patternTokens = tokens(pattern).filter(
        (t) => !(pep.season != null && episodeToken.test(t)),
      );
      if (patternTokens.length === 0)
        return { label: 'fuzzy', passed: false, detail: 'empty pattern' };
      const titleSet = new Set(tokens(title));
      const present = patternTokens.filter((t) => titleSet.has(t)).length;
      const ratio = present / patternTokens.length;
      const passed = ratio >= FUZZY_THRESHOLD;
      return {
        label: 'fuzzy',
        passed,
        detail: `token similarity ${(ratio * 100).toFixed(0)}% (threshold ${FUZZY_THRESHOLD * 100}%)`,
      };
    }
    default:
      return { label: 'match', passed: false, detail: `unknown match type ${candidate.matchType}` };
  }
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(body, 'i');
}

// --- full candidate evaluation ------------------------------------------

export function evaluateCandidate(
  candidate: MatchCandidateInput,
  ctx: ItemContext,
  parsed: ParsedRelease = parseRelease(ctx.title),
): CandidateResult {
  const base = {
    candidateId: candidate.id,
    name: candidate.name,
    priorityOrder: candidate.priorityOrder,
    matchType: candidate.matchType,
  };

  if (!candidate.enabled) {
    return { ...base, result: 'disabled', reason: 'candidate disabled', checks: [] };
  }

  const checks: CheckResult[] = [];
  const fail = (reason: string): CandidateResult => ({ ...base, result: 'failed', reason, checks });

  // Feed scope
  const scopeIds = candidate.feedScope?.feedIds ?? [];
  if (scopeIds.length > 0 && ctx.feedId && !scopeIds.includes(ctx.feedId)) {
    const c = { label: 'feed scope', passed: false, detail: 'feed not in candidate scope' };
    checks.push(c);
    return { ...base, result: 'skipped', reason: c.detail, checks };
  }

  // Core pattern / type
  const core = coreMatch(candidate, ctx, parsed);
  checks.push(core);
  if (!core.passed) return fail(core.detail);

  const normTitle = normalize(ctx.title);

  // Required terms
  for (const term of candidate.requiredTerms ?? []) {
    const passed = normTitle.includes(normalize(term));
    checks.push({ label: 'required term', passed, detail: passed ? `has “${term}”` : `missing required term “${term}”` });
    if (!passed) return fail(`missing required term “${term}”`);
  }

  // Excluded terms
  for (const term of candidate.excludedTerms ?? []) {
    const present = normTitle.includes(normalize(term));
    checks.push({ label: 'excluded term', passed: !present, detail: present ? `contains excluded term “${term}”` : `no “${term}”` });
    if (present) return fail(`contains excluded term “${term}”`);
  }

  // Quality rules
  const qr = candidate.qualityRules ?? {};
  if (qr.resolution) {
    const passed = !!parsed.resolution && compact(parsed.resolution) === compact(qr.resolution);
    checks.push({ label: 'resolution', passed, detail: passed ? `resolution ${qr.resolution}` : `resolution ${qr.resolution} required (got ${parsed.resolution ?? 'none'})` });
    if (!passed) return fail(`resolution ${qr.resolution} required`);
  }
  if (qr.source) {
    const passed = !!parsed.source && sourceEquivalent(parsed.source, qr.source);
    checks.push({ label: 'source', passed, detail: passed ? `source ${qr.source}` : `source ${qr.source} required (got ${parsed.source ?? 'none'})` });
    if (!passed) return fail(`source ${qr.source} required`);
  }
  if (qr.codec) {
    const passed = !!parsed.codec && codecEquivalent(parsed.codec, qr.codec);
    checks.push({ label: 'codec', passed, detail: passed ? `codec ${qr.codec}` : `codec ${qr.codec} required (got ${parsed.codec ?? 'none'})` });
    if (!passed) return fail(`codec ${qr.codec} required`);
  }
  if (qr.quality) {
    const passed = normTitle.includes(normalize(qr.quality));
    checks.push({ label: 'quality', passed, detail: passed ? `quality ${qr.quality}` : `quality ${qr.quality} required` });
    if (!passed) return fail(`quality ${qr.quality} required`);
  }

  // Size rules
  const sr = candidate.sizeRules ?? {};
  if (sr.minBytes != null || sr.maxBytes != null) {
    if (ctx.sizeBytes == null) {
      checks.push({ label: 'size', passed: true, detail: 'size unknown — skipping size rule' });
    } else {
      if (sr.minBytes != null && ctx.sizeBytes < sr.minBytes)
        return fail(`below minimum size (${ctx.sizeBytes} < ${sr.minBytes})`);
      if (sr.maxBytes != null && ctx.sizeBytes > sr.maxBytes)
        return fail(`above maximum size (${ctx.sizeBytes} > ${sr.maxBytes})`);
      checks.push({ label: 'size', passed: true, detail: 'within size limits' });
    }
  }

  return { ...base, result: 'matched', reason: 'all checks passed', checks };
}

/**
 * Evaluate an ordered candidate list. Stops at the first match; remaining
 * candidates are reported as skipped. Lower priorityOrder = higher preference.
 */
export function evaluatePreferenceList(
  candidates: MatchCandidateInput[],
  ctx: ItemContext,
): ListEvaluation {
  const parsed = parseRelease(ctx.title);
  const ordered = [...candidates].sort((a, b) => a.priorityOrder - b.priorityOrder);
  const results: CandidateResult[] = [];
  let matchedId: string | null = null;
  let matchedPriority: number | null = null;

  for (const candidate of ordered) {
    if (matchedId) {
      results.push({
        candidateId: candidate.id,
        name: candidate.name,
        priorityOrder: candidate.priorityOrder,
        matchType: candidate.matchType,
        result: 'skipped',
        reason: 'a higher-priority candidate already matched',
        checks: [],
      });
      continue;
    }
    const res = evaluateCandidate(candidate, ctx, parsed);
    results.push(res);
    if (res.result === 'matched') {
      matchedId = candidate.id;
      matchedPriority = candidate.priorityOrder;
    }
  }

  return {
    matched: matchedId !== null,
    matchedCandidateId: matchedId,
    matchedCandidatePriority: matchedPriority,
    action: matchedId ? 'download' : 'none',
    candidates: results,
    parsed,
  };
}

/** Best-effort conversion of a simple text pattern into an equivalent regex. */
export function toRegexPattern(text: string): string {
  return text
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '[\\s._-]+');
}
