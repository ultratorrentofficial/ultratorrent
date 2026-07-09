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

/**
 * Tokens of a release's *show-title region* — everything before the first
 * episode marker (`S02E13`, `2x13`, `Season 2`). For a release with no episode
 * marker (a movie) this is the whole name. Used to anchor title matching to the
 * show name so a rule for "Severance" doesn't match a *Law & Order* episode
 * whose own title happens to be "Severance" (the word only appears *after* the
 * SxxEyy). Quality/format words are still matched against the full name.
 */
function showRegionTokens(input: string): string[] {
  const norm = normalize(input);
  const cut = norm.search(/\bs\d{1,2}e\d{1,3}\b|\b\d{1,2}x\d{1,3}\b|\bseason\b/);
  return (cut >= 0 ? norm.slice(0, cut) : norm).split(' ').filter(Boolean);
}

/** Drop a single leading English article so "The Equalizer" and "Equalizer"
 * anchor identically. Never empties the list. */
function dropLeadingArticle(toks: string[]): string[] {
  return toks.length > 1 && (toks[0] === 'the' || toks[0] === 'a' || toks[0] === 'an')
    ? toks.slice(1)
    : toks;
}

/**
 * A "smart" show/movie pattern IS the title, so it must equal the release's
 * **pure title** — the show-title region tokens up to the first release year or
 * quality/format token. Two failure modes this closes:
 *  - Set-membership / mid-title bleed: "Rise" must not grab "The Pendragon Cycle
 *    Rise of the Merlin" (the title isn't just "Rise").
 *  - Spinoff bleed: "9-1-1" must not grab "9-1-1 Lone Star" even though it IS a
 *    prefix — the extra title words "Lone Star" make it a different show. It still
 *    matches "9-1-1", "9-1-1 2018", and the Lone Star rule matches Lone Star.
 * A trailing year ("The Equalizer 2021") and, for movies (no SxxEyy to bound the
 * region), the quality tail ("Dune Part Two 2024 2160p BluRay x265 DTS-HD-RARBG")
 * are stripped before comparing; leading-article differences are ignored. A
 * *leading* year is kept — it can be the whole title ("2020").
 */
function showTitleMatch(pattern: string, title: string): boolean {
  if (!pattern) return true;
  const pat = dropLeadingArticle(tokens(pattern));
  if (pat.length === 0) return true;
  const region = dropLeadingArticle(showRegionTokens(title));
  let end = region.length;
  for (let i = 0; i < region.length; i++) {
    const isYear = /^(19|20)\d{2}$/.test(region[i]);
    // A year only bounds the title when it isn't the leading (title) token;
    // a quality/format token never belongs to a title, so it always bounds it.
    if ((isYear && i > 0) || FORMAT_TOKEN.test(region[i])) {
      end = i;
      break;
    }
  }
  const pureTitle = region.slice(0, end);
  return pat.length === pureTitle.length && pat.every((w, i) => pureTitle[i] === w);
}

/**
 * A pattern word that denotes quality/format/episode metadata rather than the
 * title. Everything *before* the first such word is the title; the rest are
 * quality tokens. Bare digits/years are deliberately excluded — they can be
 * part of a title (`9-1-1`, `1917`, `1883`).
 */
const FORMAT_TOKEN =
  /^(2160p|1080p|1080i|720p|480p|x265|h265|hevc|x264|h264|avc|av1|xvid|web|webdl|webrip|bluray|bdrip|brrip|hdtv|hdrip|dvd|dvdrip|remux|proper|repack|hdr|hdr10|10bit|multi|s\d{1,2}e\d{1,3}|\d{1,2}x\d{1,3})$/;

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
      // Token-AND with WHOLE-token matching, split into title vs quality:
      //
      //  - The pattern's leading *title* words (everything before the first
      //    quality/format token) must each appear as a WHOLE token in the
      //    release's SHOW-TITLE region (before its SxxEyy). This anchors the
      //    match to the show name: it rejects both substring bleed
      //    ("boys" inside "cow­boys"; "9"/"1" inside "S09E07"/"1080p"; "m"/"a"
      //    from "megusta") AND episode-title collisions (a "Severance" rule
      //    must not grab a Law & Order episode *titled* "Severance", since that
      //    word sits after the SxxEyy, outside the show-title region).
      //  - The trailing *quality* words (resolution/codec/source/group) must
      //    each appear as a whole token anywhere in the release.
      //
      // Whole tokens are order/gap-insensitive, so an episode token between the
      // title and the group still matches (Agent.Kim.Reactivated.S01E03.XviD-AFG).
      const words = tokens(pattern);
      if (words.length === 0) {
        return { label: 'contains text', passed: false, detail: 'empty pattern' };
      }
      let split = words.findIndex((w) => FORMAT_TOKEN.test(w));
      if (split < 0) split = words.length;
      const titleWords = words.slice(0, split);
      const qualityWords = words.slice(split);
      const showTokens = new Set(showRegionTokens(title));
      const releaseTokens = new Set(tokens(title));
      const missing = [
        ...titleWords.filter((w) => !showTokens.has(w)),
        ...qualityWords.filter((w) => !releaseTokens.has(w)),
      ];
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
      // Anchor the pattern to the START of the show-title region (before SxxEyy),
      // so a rule never matches on a word that only appears in the *episode* title
      // AND never bleeds a short title into a longer one ("Rise" ⊄ "The Pendragon
      // Cycle Rise of the Merlin").
      const titleOk = showTitleMatch(pattern, title);
      if (!titleOk) return { label: 'smart episode', passed: false, detail: `show title “${pattern}” not found` };
      if (qr.season != null && parsed.season !== qr.season)
        return { label: 'smart episode', passed: false, detail: `season ${qr.season} not found (got ${parsed.season ?? 'none'})` };
      if (qr.episode != null && parsed.episode !== qr.episode)
        return { label: 'smart episode', passed: false, detail: `episode ${qr.episode} not found (got ${parsed.episode ?? 'none'})` };
      return { label: 'smart episode', passed: true, detail: `matched S${qr.season}E${qr.episode}` };
    }
    case 'smart_movie_match': {
      // A movie has no SxxEyy, so the show-title region is the whole name; the
      // pattern must be its leading tokens (prefix), not a word buried inside.
      const titleOk = showTitleMatch(pattern, title);
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
