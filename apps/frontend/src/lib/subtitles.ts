/**
 * Reading subtitle files well enough to show them, and to hand them to a
 * `<video>`.
 *
 * Two jobs, one parser. The viewer wants cues as data — so it can list them,
 * search them, show how long each one is on screen and jump the player to one —
 * and the player wants WebVTT, because that is the only format `<track>` takes.
 * A download directory holds SRT far more often than VTT, so "attach the
 * subtitle sitting next to the film" means converting it first.
 *
 * Pure: text in, cues out. No DOM, no fetch.
 */

export type SubtitleFormat = 'srt' | 'vtt' | 'ass' | 'unknown';

export interface SubtitleCue {
  /** 1-based position in the file, not the file's own (often wrong) numbering. */
  index: number;
  /** Milliseconds from the start of the media. */
  startMs: number;
  endMs: number;
  /** Cue text with markup stripped, newlines preserved. */
  text: string;
}

export interface ParsedSubtitle {
  format: SubtitleFormat;
  cues: SubtitleCue[];
  /**
   * Things wrong with the file that a reader should know about — overlapping or
   * backwards timings, cues with no text. Surfaced rather than silently fixed:
   * a subtitle that misbehaves in a player usually misbehaves for a reason
   * visible right here.
   */
  warnings: string[];
}

/** `HH:MM:SS,mmm` / `HH:MM:SS.mmm` / `H:MM:SS.cc` → ms. NaN when unparseable. */
export function clockToMs(clock: string): number {
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?\s*$/.exec(clock);
  if (!m) return Number.NaN;
  const [, h, mm, ss, frac] = m;
  /*
   * ASS counts hundredths, SRT/VTT thousandths, and both write the fraction
   * after a dot. Padding on the right rather than parsing as an integer is what
   * makes `.5` half a second instead of five milliseconds.
   */
  const ms = frac ? Number(frac.padEnd(3, '0')) : 0;
  return ((Number(h ?? 0) * 60 + Number(mm)) * 60 + Number(ss)) * 1000 + ms;
}

/** ms → `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (VTT). */
export function msToClock(ms: number, sep: ',' | '.' = ','): string {
  const v = Math.max(0, Math.round(ms));
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(v / 3_600_000))}:${pad(Math.floor((v % 3_600_000) / 60_000))}:${pad(
    Math.floor((v % 60_000) / 1000),
  )}${sep}${pad(v % 1000, 3)}`;
}

/** Short `M:SS` / `H:MM:SS` label for a timeline, where milliseconds are noise. */
export function msToShortClock(ms: number): string {
  const v = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = v % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Which format this text is, from its own contents rather than its name. */
export function detectSubtitleFormat(text: string): SubtitleFormat {
  const head = text.slice(0, 4096);
  if (/^﻿?WEBVTT/.test(head)) return 'vtt';
  if (/^\s*\[Script Info\]/im.test(head) || /^Dialogue:/m.test(head)) return 'ass';
  if (/\d{1,2}:\d{2}:\d{2},\d{1,3}\s*-->/.test(head)) return 'srt';
  if (/-->/.test(head)) return 'vtt';
  return 'unknown';
}

/**
 * Strip the markup a cue may carry — SRT's HTML-ish tags, VTT's `<v Speaker>`
 * and ASS's `{\pos(…)}` override blocks — leaving the words.
 *
 * Rendering the tags instead would be worse than useless: `{\an8}` at the head
 * of every line is noise, and letting raw `<i>` through into the DOM would make
 * a subtitle file an injection vector.
 */
export function stripCueMarkup(text: string): string {
  return text
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\\N|\\n/g, '\n')
    .replace(/\\h/g, ' ')
    .trim();
}

/** SRT and WebVTT share a cue shape; only the separator and header differ. */
function parseTimedBlocks(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  // Normalise line endings first — a CRLF file otherwise leaves a stray \r on
  // every timing line and nothing matches.
  const body = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const blocks = body.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;
    const timingIndex = lines.findIndex((l) => l.includes('-->'));
    if (timingIndex === -1) continue; // WEBVTT header, NOTE/STYLE blocks, stray numbering
    const timing = /(\S+)\s*-->\s*(\S+)/.exec(lines[timingIndex]);
    if (!timing) continue;
    const startMs = clockToMs(timing[1]);
    const endMs = clockToMs(timing[2]);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;
    cues.push({
      index: cues.length + 1,
      startMs,
      endMs,
      text: stripCueMarkup(lines.slice(timingIndex + 1).join('\n')),
    });
  }
  return cues;
}

/** ASS/SSA: cues live on `Dialogue:` lines, with fields named by `Format:`. */
function parseAss(text: string): SubtitleCue[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // The field order is declared per-file, so the Start/End/Text columns are
  // read from `Format:` rather than assumed to sit at the usual offsets.
  let fields: string[] = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];
  const cues: SubtitleCue[] = [];
  for (const line of lines) {
    if (/^Format:/i.test(line) && /Start/i.test(line)) {
      fields = line.slice(line.indexOf(':') + 1).split(',').map((f) => f.trim());
      continue;
    }
    if (!/^Dialogue:/i.test(line)) continue;
    // Text is last and may itself contain commas, so split only up to it.
    const parts = line.slice(line.indexOf(':') + 1).split(',');
    const textIndex = fields.findIndex((f) => /^Text$/i.test(f));
    const get = (name: string) => {
      const i = fields.findIndex((f) => f.toLowerCase() === name);
      return i === -1 ? '' : parts[i]?.trim() ?? '';
    };
    const startMs = clockToMs(get('start'));
    const endMs = clockToMs(get('end'));
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;
    const body = textIndex === -1 ? '' : parts.slice(textIndex).join(',');
    cues.push({ index: cues.length + 1, startMs, endMs, text: stripCueMarkup(body) });
  }
  return cues;
}

/** Parse any supported subtitle text into cues, with whatever is wrong with it. */
export function parseSubtitles(text: string, format?: SubtitleFormat): ParsedSubtitle {
  const detected = format && format !== 'unknown' ? format : detectSubtitleFormat(text);
  const cues = detected === 'ass' ? parseAss(text) : parseTimedBlocks(text);
  const warnings: string[] = [];

  const empty = cues.filter((c) => c.text === '').length;
  if (empty > 0) warnings.push(`${empty} cue${empty === 1 ? '' : 's'} with no text`);
  const backwards = cues.filter((c) => c.endMs < c.startMs).length;
  if (backwards > 0) warnings.push(`${backwards} cue${backwards === 1 ? '' : 's'} end before they start`);
  /*
   * Overlap is counted against the previous cue's end, not sorted order: a file
   * whose cues are out of order overlaps by definition, and reporting it once
   * per pair is more useful than reporting "unsorted" and leaving the reader to
   * find where.
   */
  let overlaps = 0;
  for (let i = 1; i < cues.length; i += 1) {
    if (cues[i].startMs < cues[i - 1].endMs) overlaps += 1;
  }
  if (overlaps > 0) warnings.push(`${overlaps} overlapping cue${overlaps === 1 ? '' : 's'}`);
  if (cues.length === 0) warnings.push('No cues could be read from this file');

  return { format: detected, cues, warnings };
}

/**
 * Render cues as WebVTT, the only subtitle format a `<track>` element accepts.
 *
 * Built from parsed cues rather than by patching the original text, so an SRT,
 * an ASS and an already-valid VTT all come out the same way — and anything the
 * parser could not read is simply absent instead of arriving malformed.
 */
export function toVtt(parsed: ParsedSubtitle): string {
  const body = parsed.cues
    .filter((c) => c.text !== '' && c.endMs > c.startMs)
    .map((c) => `${c.index}\n${msToClock(c.startMs, '.')} --> ${msToClock(c.endMs, '.')}\n${c.text}`)
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

/**
 * Which of these files are subtitles for `mediaName`.
 *
 * Convention, not metadata: a subtitle sits beside its film sharing the stem,
 * with the language tacked on — `Film.2019.1080p.mkv` next to
 * `Film.2019.1080p.en.srt`. Files that merely happen to be in the same folder
 * are excluded, because a season directory holds twenty of them and none but
 * one belongs to the episode being watched.
 */
export function matchSubtitlesFor(mediaName: string, names: string[]): string[] {
  const stem = mediaName.replace(/\.[^.]+$/, '').toLowerCase();
  return names.filter((n) => {
    const lower = n.toLowerCase();
    if (!/\.(srt|vtt|ass|ssa|sub|sbv)$/.test(lower)) return false;
    return lower.startsWith(`${stem}.`) || lower.replace(/\.[^.]+$/, '') === stem;
  });
}

/**
 * The language a subtitle filename claims, from the tag between the stem and the
 * extension (`…​.en.srt`, `…​.pt-BR.srt`, `…​.spanish.srt`). `null` when it
 * claims nothing — an unlabelled `film.srt` is common and guessing would be worse.
 */
export function subtitleLanguageTag(name: string): string | null {
  const m = /\.([A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?|[A-Za-z]{4,})\.(?:srt|vtt|ass|ssa|sub|sbv)$/i.exec(name);
  if (!m) return null;
  const tag = m[1];
  // `forced` / `sdh` / `hi` are flags, not languages.
  return /^(forced|sdh|hi|cc)$/i.test(tag) ? null : tag;
}
