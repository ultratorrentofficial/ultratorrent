/**
 * Parses a scene/p2p release name into structured metadata and explains how
 * each field was derived, then builds a ranked list of RSS match candidates.
 *
 * Pure and dependency-free for easy unit testing.
 */
import type { MatchCandidateInput } from './match-engine';

export type ContentType = 'tv_episode' | 'anime_episode' | 'movie' | 'daily' | 'unknown';

export interface ParseExplanation {
  field: string;
  value: string;
  reason: string;
}

export interface ParsedTorrentMeta {
  title: string | null;
  season: number | null;
  episode: number | null;
  absoluteEpisode: number | null;
  part: number | null;
  airDate: string | null; // YYYY-MM-DD for daily shows
  year: number | null;
  resolution: string | null;
  source: string | null;
  codec: string | null;
  audio: string[];
  hdr: string[];
  languages: string[];
  releaseGroup: string | null;
  proper: boolean;
  repack: boolean;
  contentType: ContentType;
  explanations: ParseExplanation[];
  warnings: string[];
  confidence: number; // 0-100
}

export interface GeneratedCandidate {
  name: string;
  description: string;
  matchType: MatchCandidateInput['matchType'];
  pattern: string;
  requiredTerms: string[];
  excludedTerms: string[];
  qualityRules: NonNullable<MatchCandidateInput['qualityRules']>;
  confidence: 'high' | 'medium' | 'low';
}

// --- token tables --------------------------------------------------------

const RES = /\b(2160p|4k|uhd|1080p|1080i|720p|480p)\b/i;
const SOURCE: Array<[RegExp, string]> = [
  [/\bweb[\s._-]?dl\b/i, 'WEB-DL'],
  [/\bwebrip\b/i, 'WEBRip'],
  [/\b(blu[\s._-]?ray|bdrip|brrip|bdmux)\b/i, 'BluRay'],
  [/\bremux\b/i, 'Remux'],
  [/\bhdtv\b/i, 'HDTV'],
  [/\b(dvdrip|dvd)\b/i, 'DVD'],
  [/\bhdrip\b/i, 'HDRip'],
  [/\bweb\b/i, 'WEB'],
];
const CODEC: Array<[RegExp, string]> = [
  [/\b(x265|h[\s.]?265|hevc)\b/i, 'x265'],
  [/\b(x264|h[\s.]?264|avc)\b/i, 'x264'],
  [/\bav1\b/i, 'AV1'],
  [/\bxvid\b/i, 'XviD'],
];
const AUDIO: Array<[RegExp, string]> = [
  [/\batmos\b/i, 'Atmos'],
  [/\btrue[\s._-]?hd\b/i, 'TrueHD'],
  [/\bdts[\s._-]?hd\b/i, 'DTS-HD'],
  [/\bdts\b/i, 'DTS'],
  [/\b(eac3|e-ac-3|ddp|dd\+)\b/i, 'DDP'],
  [/\b(ac3|dd5\.?1|dolby digital)\b/i, 'AC3'],
  [/\baac\b/i, 'AAC'],
  [/\bflac\b/i, 'FLAC'],
  [/\bopus\b/i, 'Opus'],
  [/\bmp3\b/i, 'MP3'],
];
const HDR: Array<[RegExp, string]> = [
  [/\bhdr10\+\b/i, 'HDR10+'],
  [/\bhdr10\b/i, 'HDR10'],
  [/\bhdr\b/i, 'HDR'],
  [/\b(dolby[\s._-]?vision|dovi|\bdv\b)\b/i, 'DV'],
];
const LANG = /\b(multi|vostfr|truefrench|french|german|ita|italian|spanish|dual|japanese|jpn|nordic|dutch|korean|kor)\b/gi;

function normRes(r: string): string {
  const x = r.toLowerCase();
  return x === '4k' || x === 'uhd' ? '2160p' : x;
}

function stripExtension(name: string): string {
  return name.replace(/\.(mkv|mp4|avi|ts|m2ts|torrent)$/i, '');
}

// --- parser --------------------------------------------------------------

export function parseTorrentName(raw: string): ParsedTorrentMeta {
  const explanations: ParseExplanation[] = [];
  const warnings: string[] = [];
  const explain = (field: string, value: string, reason: string) =>
    explanations.push({ field, value, reason });

  let name = stripExtension(raw.trim());

  const meta: ParsedTorrentMeta = {
    title: null, season: null, episode: null, absoluteEpisode: null, part: null,
    airDate: null, year: null, resolution: null, source: null, codec: null,
    audio: [], hdr: [], languages: [], releaseGroup: null, proper: false,
    repack: false, contentType: 'unknown', explanations, warnings, confidence: 0,
  };

  // Release group: token after the final dash (scene convention).
  const groupMatch = /-([A-Za-z0-9][A-Za-z0-9_]{1,24})$/.exec(name);
  if (groupMatch) {
    meta.releaseGroup = groupMatch[1];
    explain('Release Group', groupMatch[1], 'Detected after the final dash.');
    name = name.slice(0, groupMatch.index); // remove "-GROUP" before further parsing
  } else {
    warnings.push('No release group detected (name may not be a scene/p2p release).');
  }

  // Work on a separator-normalized copy for marker positions.
  const ws = name.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Episode / season
  let cutIndex = ws.length;
  const setCut = (i: number) => { if (i >= 0 && i < cutIndex) cutIndex = i; };

  let m: RegExpExecArray | null;
  if ((m = /s(\d{1,2})[\s._-]*e(\d{1,3})/i.exec(ws))) {
    meta.season = +m[1]; meta.episode = +m[2];
    explain('Season/Episode', `S${meta.season}E${meta.episode}`, `Detected from "${m[0].trim()}".`);
    setCut(m.index);
  } else if ((m = /\b(\d{1,2})x(\d{1,3})\b/i.exec(ws))) {
    meta.season = +m[1]; meta.episode = +m[2];
    explain('Season/Episode', `S${meta.season}E${meta.episode}`, `Detected from "${m[0].trim()}" (NxNN format).`);
    setCut(m.index);
  } else if ((m = /season[\s._-]*(\d{1,2})[\s._-]*episode[\s._-]*(\d{1,3})/i.exec(ws))) {
    meta.season = +m[1]; meta.episode = +m[2];
    explain('Season/Episode', `S${meta.season}E${meta.episode}`, 'Detected from "Season N Episode N".');
    setCut(m.index);
  }

  // Daily airdate
  if ((m = /\b(20\d{2})[.\-/ ](\d{2})[.\-/ ](\d{2})\b/.exec(ws))) {
    meta.airDate = `${m[1]}-${m[2]}-${m[3]}`;
    explain('Air Date', meta.airDate, 'Detected YYYY.MM.DD date pattern.');
    setCut(m.index);
  }

  // Part
  if ((m = /\bpart[\s._-]*(\d{1,2})\b/i.exec(ws))) {
    meta.part = +m[1];
    explain('Part', String(meta.part), `Detected from "${m[0].trim()}".`);
    setCut(m.index);
  }

  // Absolute / bare episode (anime): "Episode 05", "E05", or " - 05 "
  if (meta.episode === null) {
    if ((m = /\bepisode[\s._-]*(\d{1,3})\b/i.exec(ws)) || (m = /\be(\d{2,3})\b/i.exec(ws)) || (m = /\s-\s(\d{1,3})\s/.exec(` ${ws} `))) {
      meta.absoluteEpisode = +m[1];
      explain('Episode', String(meta.absoluteEpisode), `Detected absolute episode from "${m[0].trim()}".`);
      const idx = ws.indexOf(m[0].trim());
      setCut(idx);
    }
  }

  // Year — a title can *start* with a 4-digit year (e.g. "1917 (2019)"), so
  // collect every candidate and choose deliberately rather than taking the
  // first: prefer a parenthesized "(YYYY)" (the release-year convention), else
  // the last one. Crucially, never treat a year at position 0 as the title
  // boundary — that would collapse the whole title to empty. (\b already keeps
  // this from matching a resolution's digits.)
  const yearMatches = [...ws.matchAll(/\b(19|20)\d{2}\b/g)];
  if (yearMatches.length) {
    const parenYear = yearMatches.find(
      (ym) => ws[ym.index - 1] === '(' && ws[ym.index + 4] === ')',
    );
    const chosen = parenYear ?? yearMatches[yearMatches.length - 1];
    meta.year = +chosen[0];
    explain('Year', String(meta.year), `Detected four-digit year "${meta.year}".`);
    // Year is a title boundary only when there's no episode marker and it isn't
    // the leading token (a leading year is part of the title, not a boundary).
    if (meta.season === null && meta.absoluteEpisode === null && chosen.index > 0) {
      setCut(chosen.index);
    }
  }

  // Resolution
  const res = RES.exec(ws);
  if (res) { meta.resolution = normRes(res[1]); explain('Resolution', meta.resolution, `Detected from "${res[1]}".`); setCut(res.index); }
  else warnings.push('No resolution detected (e.g. 1080p).');

  // Source
  for (const [re, label] of SOURCE) { const sm = re.exec(ws); if (sm) { meta.source = label; explain('Source', label, `Detected from "${sm[0].trim()}".`); setCut(sm.index); break; } }
  if (!meta.source) warnings.push('No source detected (e.g. WEB-DL, BluRay).');

  // Codec
  for (const [re, label] of CODEC) { const cm = re.exec(ws); if (cm) { meta.codec = label; explain('Codec', label, `Detected from "${cm[0].trim()}".`); setCut(cm.index); break; } }

  // Audio (multiple)
  for (const [re, label] of AUDIO) if (re.test(ws) && !meta.audio.includes(label)) meta.audio.push(label);
  if (meta.audio.length) explain('Audio', meta.audio.join(', '), 'Detected audio format token(s).');

  // HDR
  for (const [re, label] of HDR) if (re.test(ws) && !meta.hdr.includes(label)) meta.hdr.push(label);
  if (meta.hdr.length) explain('HDR', meta.hdr.join(', '), 'Detected HDR/Dolby Vision token(s).');

  // Languages
  const langs = ws.match(LANG);
  if (langs) { meta.languages = [...new Set(langs.map((l) => l.toUpperCase()))]; explain('Language', meta.languages.join(', '), 'Detected language tag(s).'); }

  // Proper / repack
  if (/\bproper\b/i.test(ws)) { meta.proper = true; explain('Flag', 'PROPER', 'Detected PROPER (re-release fixing a prior issue).'); }
  if (/\brepack\b/i.test(ws)) { meta.repack = true; explain('Flag', 'REPACK', 'Detected REPACK (corrected release).'); }

  // Title = everything before the earliest marker
  let title = ws.slice(0, cutIndex).replace(/[\s\-]+$/, '').trim();
  // Drop a leading "[Group] " anime fansub tag from the title but record it.
  const fansub = /^\[([^\]]+)\]\s*/.exec(title);
  if (fansub) {
    if (!meta.releaseGroup) { meta.releaseGroup = fansub[1]; explain('Release Group', fansub[1], 'Detected from leading [..] fansub tag.'); }
    title = title.slice(fansub[0].length).trim();
  }
  title = title.replace(/[\[\]()]/g, '').replace(/\s+/g, ' ').trim();
  if (title) {
    meta.title = title;
    const boundary = meta.season !== null ? `S${meta.season}E${meta.episode}` : meta.year !== null ? String(meta.year) : 'the first metadata token';
    explain('Title', title, `Detected from the tokens before ${boundary}.`);
  } else {
    warnings.push('Could not confidently determine the title.');
  }

  // Content type
  if (meta.season !== null && meta.episode !== null) meta.contentType = 'tv_episode';
  else if (meta.airDate) meta.contentType = 'daily';
  else if (meta.absoluteEpisode !== null) meta.contentType = 'anime_episode';
  else if (meta.year !== null) meta.contentType = 'movie';
  else meta.contentType = 'unknown';
  explain('Content Type', meta.contentType.replace('_', ' '), 'Inferred from the detected episode/year markers.');

  // Confidence
  let score = 0;
  if (meta.title) score += 30;
  if (meta.season !== null && meta.episode !== null) score += 25;
  else if (meta.absoluteEpisode !== null || meta.airDate || meta.year !== null) score += 18;
  if (meta.resolution) score += 15;
  if (meta.source) score += 15;
  if (meta.codec) score += 10;
  if (meta.releaseGroup) score += 5;
  meta.confidence = Math.min(100, score);

  return meta;
}

// --- logical release identity --------------------------------------------

/**
 * A stable key for the *logical thing* a release represents — the movie or the
 * specific episode — independent of quality, source, codec, or release group.
 * Two releases with the same identity are the same acquisition target, so a rule
 * should hold only one of them (the highest-priority). Returns null when the
 * title can't be identified confidently, so callers fall back to per-release
 * behavior (never wrongly collapse two distinct things).
 */
export function releaseIdentity(title: string): string | null {
  const meta = parseTorrentName(title);
  if (!meta.title) return null;
  const t = meta.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!t) return null;
  switch (meta.contentType) {
    case 'tv_episode':
      return `ep:${t}:${meta.season}:${meta.episode}`;
    case 'anime_episode':
      return `anime:${t}:${meta.absoluteEpisode}`;
    case 'daily':
      return `daily:${t}:${meta.airDate}`;
    case 'movie':
      return `movie:${t}:${meta.year ?? ''}`;
    default:
      return null; // unknown shape — don't risk collapsing unrelated releases
  }
}

// --- candidate generation ------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** Title with literal escaped dots between words, e.g. The\.Example\.Show */
function dottedTitle(title: string): string {
  return title.trim().split(/\s+/).map(escapeRegex).join('\\.');
}
function epToken(meta: ParsedTorrentMeta): string {
  if (meta.season !== null && meta.episode !== null) {
    return `S${String(meta.season).padStart(2, '0')}E${String(meta.episode).padStart(2, '0')}`;
  }
  if (meta.absoluteEpisode !== null) return String(meta.absoluteEpisode).padStart(2, '0');
  return '';
}

export function buildSmartCandidates(meta: ParsedTorrentMeta): GeneratedCandidate[] {
  const out: GeneratedCandidate[] = [];
  const title = meta.title ?? '';
  const ep = epToken(meta);
  const qualityCore: GeneratedCandidate['qualityRules'] = {};
  if (meta.resolution) qualityCore.resolution = meta.resolution;
  if (meta.source) qualityCore.source = meta.source;
  if (meta.codec) qualityCore.codec = meta.codec;

  const tail = [ep, meta.resolution, meta.source, meta.codec].filter(Boolean);
  const regexBody =
    `${dottedTitle(title)}` +
    (ep ? `\\.${ep}` : '') +
    tail.slice(1).map((t) => `.*${escapeRegex(String(t))}`).join('') +
    '.*';
  const normalizedText = [title, ...tail].filter(Boolean).join(' ');

  const isTv = meta.contentType === 'tv_episode';
  const isAnime = meta.contentType === 'anime_episode';
  const isMovie = meta.contentType === 'movie';

  // 1) Primary smart structured match
  if (isTv || isAnime) {
    out.push({
      name: 'Smart episode match',
      description: 'Structured match on title + season/episode + quality. Most reliable.',
      matchType: 'smart_episode_match',
      pattern: title,
      requiredTerms: [],
      excludedTerms: [],
      qualityRules: {
        ...qualityCore,
        ...(meta.season !== null ? { season: meta.season } : {}),
        ...(meta.episode !== null ? { episode: meta.episode } : {}),
        ...(meta.absoluteEpisode !== null ? { episode: meta.absoluteEpisode } : {}),
      },
      confidence: 'high',
    });
  } else if (isMovie) {
    out.push({
      name: 'Smart movie match',
      description: 'Structured match on title + year + quality. Most reliable.',
      matchType: 'smart_movie_match',
      pattern: title,
      requiredTerms: [],
      excludedTerms: [],
      qualityRules: { ...qualityCore, ...(meta.year !== null ? { year: meta.year } : {}) },
      confidence: 'high',
    });
  }

  // 2) Strict regex
  out.push({
    name: 'Strict regex match',
    description: 'Exact ordered pattern matching the original release shape.',
    matchType: 'regex',
    pattern: regexBody,
    requiredTerms: [],
    excludedTerms: [],
    qualityRules: {},
    confidence: 'medium',
  });

  // 3) Normalized text (contains)
  out.push({
    name: 'Normalized text match',
    description: 'Separator-insensitive "contains" match on the key tokens.',
    matchType: 'contains_text',
    pattern: normalizedText,
    requiredTerms: [],
    excludedTerms: [],
    qualityRules: {},
    confidence: 'medium',
  });

  // 4) Fuzzy fallback
  const fuzzy = isMovie
    ? [title, meta.year].filter(Boolean).join(' ')
    : meta.season !== null
      ? `${title} Season ${meta.season} Episode ${meta.episode}`
      : `${title} Episode ${meta.absoluteEpisode ?? ''}`.trim();
  out.push({
    name: 'Fuzzy fallback',
    description: 'Loose token match to catch unusual spellings/formats.',
    matchType: 'fuzzy_match',
    pattern: fuzzy,
    requiredTerms: [],
    excludedTerms: [],
    qualityRules: {},
    confidence: 'low',
  });

  return out;
}
