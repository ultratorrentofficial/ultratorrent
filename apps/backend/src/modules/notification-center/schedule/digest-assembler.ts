/** One notification eligible for a digest. */
export interface DigestCandidate {
  id: string;
  eventKey: string;
  category: string;
  severity: string;
  title: string;
  /** Repeats already collapsed at dispatch time. */
  groupCount: number;
  lastAt: Date;
}

export interface DigestLine {
  eventKey: string;
  title: string;
  /** Total occurrences, summing the collapsed repeats. */
  count: number;
  lastAt: Date;
}

export interface DigestSection {
  category: string;
  lines: DigestLine[];
  /** Total occurrences in this section, including any beyond the cap. */
  total: number;
}

export interface AssembledDigest {
  sections: DigestSection[];
  /** Distinct notifications included. */
  itemCount: number;
  /** Total occurrences across everything, including collapsed repeats. */
  occurrenceCount: number;
  /** Lines omitted by the cap — surfaced, never silently dropped. */
  overflow: number;
  /** Highest severity present, so the subject can lead with it. */
  topSeverity: string;
  isEmpty: boolean;
}

const SEVERITY_ORDER = ['info', 'success', 'warning', 'error', 'critical', 'security'];

/** Most lines a digest body renders before it stops being scannable. */
export const DEFAULT_MAX_LINES = 25;

/**
 * Group a period's notifications into a digest.
 *
 * **Aggregation happens here, not at dispatch.** Two "Torrent completed" events an
 * hour apart are separate notifications — you might want to open either — but in a
 * daily summary they are one line reading "×2". Collapsing at dispatch would lose
 * the individual records; collapsing at assembly keeps both truths.
 *
 * Sections are ordered by severity so a digest opens with what matters, not with
 * whatever happened to arrive first. Within a section, lines are ordered by recency.
 *
 * The cap bounds the rendered body — an SMS or a Telegram message has a hard limit,
 * and a 400-line digest is unreadable anyway — but the omitted count is reported so
 * the summary never quietly under-states what happened.
 */
export function assembleDigest(
  candidates: DigestCandidate[],
  maxLines = DEFAULT_MAX_LINES,
): AssembledDigest {
  if (!candidates.length) {
    return { sections: [], itemCount: 0, occurrenceCount: 0, overflow: 0, topSeverity: 'info', isEmpty: true };
  }

  // Collapse identical events into one line, summing their occurrences.
  const byCategory = new Map<string, Map<string, DigestLine>>();
  const severityByCategory = new Map<string, string>();
  let occurrenceCount = 0;

  for (const c of candidates) {
    occurrenceCount += Math.max(1, c.groupCount);
    let lines = byCategory.get(c.category);
    if (!lines) {
      lines = new Map();
      byCategory.set(c.category, lines);
    }
    const existing = lines.get(c.eventKey);
    if (existing) {
      existing.count += Math.max(1, c.groupCount);
      if (c.lastAt > existing.lastAt) existing.lastAt = c.lastAt;
    } else {
      lines.set(c.eventKey, {
        eventKey: c.eventKey,
        title: c.title,
        count: Math.max(1, c.groupCount),
        lastAt: c.lastAt,
      });
    }
    // Track the worst severity seen per category, for section ordering.
    const seen = severityByCategory.get(c.category);
    if (!seen || SEVERITY_ORDER.indexOf(c.severity) > SEVERITY_ORDER.indexOf(seen)) {
      severityByCategory.set(c.category, c.severity);
    }
  }

  const sections: DigestSection[] = [...byCategory.entries()]
    .map(([category, lines]) => {
      const ordered = [...lines.values()].sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
      return {
        category,
        lines: ordered,
        total: ordered.reduce((sum, l) => sum + l.count, 0),
      };
    })
    .sort((a, b) => {
      const sevA = SEVERITY_ORDER.indexOf(severityByCategory.get(a.category) ?? 'info');
      const sevB = SEVERITY_ORDER.indexOf(severityByCategory.get(b.category) ?? 'info');
      // Worst first; ties broken by volume, then name, so the order is stable.
      return sevB - sevA || b.total - a.total || a.category.localeCompare(b.category);
    });

  // Apply the cap across sections, keeping the ordering above.
  let remaining = maxLines;
  let overflow = 0;
  for (const section of sections) {
    if (remaining <= 0) {
      overflow += section.lines.length;
      section.lines = [];
      continue;
    }
    if (section.lines.length > remaining) {
      overflow += section.lines.length - remaining;
      section.lines = section.lines.slice(0, remaining);
    }
    remaining -= section.lines.length;
  }

  const topSeverity = candidates.reduce(
    (worst, c) => (SEVERITY_ORDER.indexOf(c.severity) > SEVERITY_ORDER.indexOf(worst) ? c.severity : worst),
    'info',
  );

  return {
    // A section emptied entirely by the cap is dropped from the body, but its
    // lines are already counted in `overflow`.
    sections: sections.filter((s) => s.lines.length > 0),
    itemCount: candidates.length,
    occurrenceCount,
    overflow,
    topSeverity,
    isEmpty: false,
  };
}

/**
 * Render a digest as plain text.
 *
 * Deliberately plain: it has to survive Telegram, an SMS-length cap and an email
 * fallback without per-channel branching, and a digest is a list — formatting adds
 * nothing a reader needs.
 */
export function renderDigestText(digest: AssembledDigest, heading: string): string {
  if (digest.isEmpty) return '';
  const lines: string[] = [heading, ''];
  for (const section of digest.sections) {
    lines.push(`${section.category.toUpperCase()}`);
    for (const l of section.lines) {
      lines.push(l.count > 1 ? `  • ${l.title} ×${l.count}` : `  • ${l.title}`);
    }
    lines.push('');
  }
  if (digest.overflow > 0) {
    lines.push(`…and ${digest.overflow} more.`);
  }
  return lines.join('\n').trim();
}
