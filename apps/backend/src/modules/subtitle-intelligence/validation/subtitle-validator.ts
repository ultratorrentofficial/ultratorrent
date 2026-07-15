/**
 * Subtitle validation — PURE structural checks over the subtitle text itself.
 *
 * Deliberately binary-free: it parses SRT / WebVTT / ASS(SSA) cues in-process and
 * catches the failure modes that actually break playback — malformed cues,
 * negative or inverted timestamps, out-of-order or overlapping cues, and empty or
 * unparseable bodies. This is the platform's graceful-degradation philosophy
 * (mediainfo/ffprobe optional): the engine can always validate, and a DEEPER
 * runtime cross-check (subtitle end vs measured media duration) layers on top in
 * the service only when a probe binary is present.
 *
 * `endMs` is exported so that optional deep pass can compare it to the media's
 * runtime without re-parsing.
 */

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  code: string;
  message: string;
  severity: IssueSeverity;
  /** 1-based cue index the issue attaches to, when applicable. */
  cue?: number;
}

export interface SubtitleValidationResult {
  format: 'srt' | 'vtt' | 'ass' | 'unknown';
  valid: boolean;
  cueCount: number;
  startMs: number | null;
  endMs: number | null;
  issues: ValidationIssue[];
}

interface Cue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

/** A gap larger than this between consecutive cues is flagged (warning only). */
export const LARGE_GAP_MS = 5 * 60_000;

// --- timestamp parsing ----------------------------------------------------

/** `HH:MM:SS,mmm` or `HH:MM:SS.mmm` (SRT/VTT). Returns ms or null. Pure. */
function parseSrtVttTime(raw: string): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(raw.trim());
  if (m) return toMs(+m[1], +m[2], +m[3], m[4]);
  // VTT allows MM:SS.mmm (no hours).
  const s = /^(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(raw.trim());
  if (s) return toMs(0, +s[1], +s[2], s[3]);
  return null;
}

/** ASS/SSA `H:MM:SS.cc` (centiseconds). Returns ms or null. Pure. */
function parseAssTime(raw: string): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[.:](\d{1,2})$/.exec(raw.trim());
  if (!m) return null;
  return toMs(+m[1], +m[2], +m[3], String(+m[4] * 10)); // cs → ms
}

function toMs(h: number, m: number, s: number, frac: string): number {
  const ms = Number(frac.padEnd(3, '0').slice(0, 3));
  return ((h * 60 + m) * 60 + s) * 1000 + ms;
}

// --- format detection & parsing ------------------------------------------

/** Sniff the subtitle format from its content + declared extension. Pure. */
export function detectFormat(content: string, ext?: string | null): SubtitleValidationResult['format'] {
  const head = content.slice(0, 4096);
  if (/^﻿?WEBVTT/.test(head)) return 'vtt';
  if (/\[Script Info\]|\[V4\+? Styles\]|\[Events\]/i.test(head)) return 'ass';
  if (/\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test(head)) return 'srt';
  const e = (ext ?? '').toLowerCase();
  if (e === 'vtt') return 'vtt';
  if (e === 'ass' || e === 'ssa') return 'ass';
  if (e === 'srt' || e === 'sub') return 'srt';
  return 'unknown';
}

function parseCues(content: string, format: SubtitleValidationResult['format']): { cues: Cue[]; malformed: number } {
  return format === 'ass' ? parseAss(content) : parseSrtVtt(content);
}

/** SRT and VTT share a `start --> end` cue grammar. */
function parseSrtVtt(content: string): { cues: Cue[]; malformed: number } {
  const cues: Cue[] = [];
  let malformed = 0;
  let index = 0;
  const lines = content.replace(/\r\n/g, '\n').replace(/^﻿/, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const arrow = /(.+?)\s*-->\s*(.+?)(\s|$)/.exec(lines[i]);
    if (!arrow) continue;
    const startMs = parseSrtVttTime(arrow[1]);
    const endMs = parseSrtVttTime(arrow[2]);
    index++;
    if (startMs == null || endMs == null) {
      malformed++;
      continue;
    }
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && lines[j].trim() !== ''; j++) body.push(lines[j]);
    cues.push({ index, startMs, endMs, text: body.join('\n') });
  }
  return { cues, malformed };
}

/** ASS/SSA `Dialogue:` events (Start = field 2, End = field 3). */
function parseAss(content: string): { cues: Cue[]; malformed: number } {
  const cues: Cue[] = [];
  let malformed = 0;
  let index = 0;
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    if (!/^Dialogue:/i.test(line)) continue;
    index++;
    const fields = line.slice(line.indexOf(':') + 1).split(',');
    const startMs = parseAssTime(fields[1] ?? '');
    const endMs = parseAssTime(fields[2] ?? '');
    if (startMs == null || endMs == null) {
      malformed++;
      continue;
    }
    cues.push({ index, startMs, endMs, text: fields.slice(9).join(',') });
  }
  return { cues, malformed };
}

// --- the validator --------------------------------------------------------

/**
 * Validate subtitle text. Returns the parsed timing envelope plus every issue
 * found. `valid` is true only when at least one cue parsed and NO error-severity
 * issue was raised (warnings such as a large gap do not invalidate). Pure.
 */
export function validateSubtitle(content: string, ext?: string | null): SubtitleValidationResult {
  const issues: ValidationIssue[] = [];
  const format = detectFormat(content, ext);

  if (!content || content.trim() === '') {
    return { format, valid: false, cueCount: 0, startMs: null, endMs: null, issues: [{ code: 'empty', message: 'Subtitle file is empty.', severity: 'error' }] };
  }
  if (format === 'unknown') {
    issues.push({ code: 'unknown_format', message: 'Content is not recognizable SRT, VTT, or ASS.', severity: 'error' });
  }

  const { cues, malformed } = parseCues(content, format === 'unknown' ? 'srt' : format);
  if (malformed > 0) {
    issues.push({ code: 'malformed_cues', message: `${malformed} cue(s) have an unparseable timestamp.`, severity: 'error' });
  }
  if (cues.length === 0) {
    issues.push({ code: 'no_cues', message: 'No valid subtitle cues were found.', severity: 'error' });
    return { format, valid: false, cueCount: 0, startMs: null, endMs: null, issues };
  }

  let startMs = Infinity;
  let endMs = -Infinity;
  let prev: Cue | null = null;
  for (const cue of cues) {
    if (cue.startMs < 0 || cue.endMs < 0) {
      issues.push({ code: 'negative_timestamp', message: 'Cue has a negative timestamp.', severity: 'error', cue: cue.index });
    }
    if (cue.endMs <= cue.startMs) {
      issues.push({ code: 'inverted_timing', message: 'Cue end is not after its start.', severity: 'error', cue: cue.index });
    }
    if (prev) {
      if (cue.startMs < prev.startMs) {
        issues.push({ code: 'out_of_order', message: 'Cue starts before the previous cue.', severity: 'error', cue: cue.index });
      } else if (cue.startMs < prev.endMs) {
        issues.push({ code: 'overlap', message: 'Cue overlaps the previous cue.', severity: 'warning', cue: cue.index });
      } else if (cue.startMs - prev.endMs > LARGE_GAP_MS) {
        issues.push({ code: 'large_gap', message: 'Unusually large gap before this cue.', severity: 'warning', cue: cue.index });
      }
    }
    startMs = Math.min(startMs, cue.startMs);
    endMs = Math.max(endMs, cue.endMs);
    prev = cue;
  }

  const valid = !issues.some((i) => i.severity === 'error');
  return {
    format,
    valid,
    cueCount: cues.length,
    startMs: Number.isFinite(startMs) ? startMs : null,
    endMs: Number.isFinite(endMs) ? endMs : null,
    issues,
  };
}
