/**
 * Attention Center — the Phase 3 vocabulary.
 *
 * Phase 1 produced facts and conclusions. Phase 2 judged quality against the
 * operator's own acquisition ladder. Phase 3 adds the only thing still
 * missing: a disciplined place for a person to decide what deserves action.
 *
 * **The Attention Center owns workflow state around a finding, never the
 * finding's technical truth.** That separation is the whole design:
 *
 *   - A finding is OPEN or RESOLVED, and only the evaluator decides which,
 *     because only the source facts can prove a condition disappeared.
 *   - A disposition is UNREVIEWED, ACKNOWLEDGED, SNOOZED or DISMISSED, and
 *     only a person decides that.
 *
 * Dismissing `EPISODES_MISSING` does not make the episodes exist. Snoozing
 * `QUALITY_BELOW_PREFERENCE` does not change a measured bitrate. The two
 * dimensions are stored separately and must never be collapsed into one
 * status field, because the moment they are, "I don't want to see this" and
 * "this is fixed" become indistinguishable — and a dashboard that cannot tell
 * those apart will eventually report a broken library as healthy.
 */

/* ------------------------------------------------------------ disposition */

/**
 * What a person has decided about a finding.
 *
 * Deliberately orthogonal to `resolvedAt`. A finding can be OPEN and
 * DISMISSED at the same time: still true, not currently wanted in the queue.
 */
export const MEDIA_ATTENTION_DISPOSITIONS = [
  /** Nobody has looked at it yet. The default for every new finding. */
  'unreviewed',
  /** Seen and understood. Stays in the queue — seeing is not deciding. */
  'acknowledged',
  /** Still true; not to be asked about again until `snoozedUntil`. */
  'snoozed',
  /** Understood and judged not actionable. Removed from the active queue. */
  'dismissed',
] as const;
export type MediaAttentionDisposition = (typeof MEDIA_ATTENTION_DISPOSITIONS)[number];

/** Dispositions a person can set directly. `unreviewed` is reached by reset. */
export const MEDIA_ATTENTION_ACTIONS = ['acknowledge', 'snooze', 'dismiss', 'reset'] as const;
export type MediaAttentionAction = (typeof MEDIA_ATTENTION_ACTIONS)[number];

/* --------------------------------------------------------------- history */

/**
 * Meaningful transitions only.
 *
 * Explicitly NOT recorded: "observed again", "still open", "projection
 * recalculated". A reconciliation sweep touches thousands of findings and
 * almost none of them changed; logging those would bury the handful of
 * entries that explain what actually happened.
 */
export const MEDIA_ATTENTION_EVENTS = [
  'opened',
  'resolved',
  'reopened',
  'acknowledged',
  'snoozed',
  'dismissed',
  /** A person cleared their own disposition. */
  'disposition_reset',
  /** The evaluator cleared it because the condition materially worsened. */
  'disposition_reset_by_escalation',
  'severity_changed',
] as const;
export type MediaAttentionEvent = (typeof MEDIA_ATTENTION_EVENTS)[number];

/** One entry in a finding's history. Bounded, and never localized prose. */
export interface MediaAttentionHistoryEntry {
  id: string;
  event: MediaAttentionEvent;
  at: string;
  /** Null for evaluator-driven transitions — no person did it. */
  actorUserId: string | null;
  actorName: string | null;
  /** Machine detail, e.g. `{from:'warning',to:'critical'}`. Small by design. */
  detail: Record<string, unknown>;
}

/* ------------------------------------------------------------- escalation */

/**
 * Whether a person's disposition survives a change in the underlying finding.
 *
 * The problem this solves: an operator dismisses "1 episode missing", and six
 * weeks later twelve are missing. The finding identity never changed, so a
 * naive implementation keeps it dismissed forever and the operator never
 * learns. Equally, a reconciliation that merely refreshes `lastObservedAt`
 * must not resurrect something they deliberately silenced.
 */
export const MEDIA_ESCALATION_RESULTS = ['keep_disposition', 'reset_to_unreviewed'] as const;
export type MediaEscalationResult = (typeof MEDIA_ESCALATION_RESULTS)[number];

/** Why a disposition was cleared. Drives both history and the UI badge. */
export const MEDIA_ESCALATION_REASONS = [
  'severity_increased',
  'affected_count_increased',
  'reopened_after_resolution',
  'evidence_changed',
] as const;
export type MediaEscalationReason = (typeof MEDIA_ESCALATION_REASONS)[number];

/* ---------------------------------------------------------- attention DTO */

/**
 * One row of the Attention queue.
 *
 * Compact on purpose: a list of several hundred must not carry each finding's
 * full evidence blob or its history. Both load on detail.
 */
export interface MediaAttentionItem {
  /** The finding row id — stable across every rebuild, so safe to address. */
  id: string;
  code: string;
  domain: string;
  severity: string;
  entityType: string;
  entityId: string;

  /** Denormalized from the projection for rendering; never authoritative. */
  title: string;
  year: number | null;
  libraryName: string | null;

  /** Technical lifecycle — the evaluator's answer. */
  open: boolean;
  firstObservedAt: string;
  lastObservedAt: string;
  resolvedAt: string | null;

  /** Human workflow — the operator's answer. Never conflated with the above. */
  disposition: MediaAttentionDisposition;
  snoozedUntil: string | null;
  dispositionAt: string | null;
  dispositionActorName: string | null;
  /** True when the evaluator cleared a disposition because things got worse. */
  escalated: boolean;
  escalationReason: MediaEscalationReason | null;

  /** A bounded, already-humanized summary. Never raw JSON for a card. */
  summary: Record<string, unknown>;
  /** Existing CAMA capability ids. Empty when nothing can act on it. */
  actionCapabilityIds: string[];
  /** Deterministic ordering rank; lower sorts first. See the query service. */
  priority: number;
}

/** Counts for the Attention overview. Same semantics as the list, by contract. */
export interface MediaAttentionSummary {
  /** Open, not dismissed, not currently snoozed. */
  active: number;
  critical: number;
  error: number;
  warning: number;
  opportunity: number;
  info: number;
  /** Open and snoozed with an unexpired timer. */
  snoozed: number;
  /** Open and dismissed. Still true, deliberately out of the queue. */
  dismissed: number;
  /** Active and never looked at. */
  unreviewed: number;
  /** Active with a disposition cleared by material escalation. */
  escalated: number;
}

export interface MediaAttentionListResult {
  items: MediaAttentionItem[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * One title and every finding currently open against it.
 *
 * Grouping is by MEDIA, not by episode — findings are keyed on the show, and
 * a library sweep produces none at episode level, so grouping any finer would
 * aggregate nothing. On the reference library this turns ~940 rows into ~673
 * cards: a real reduction, not a dramatic one, and the honest claim is that
 * it puts a title's several problems in one place rather than scattering them.
 */
export interface MediaAttentionGroup {
  entityType: string;
  entityId: string;
  title: string;
  year: number | null;
  libraryName: string | null;
  /**
   * The WORST severity contained, never an average and never the first one
   * found. A critical child must not hide behind a card that reads warning.
   */
  severity: string;
  /** Lowest (most urgent) member rank, so groups order like their contents. */
  priority: number;
  findingCount: number;
  /** True when any member's disposition was cleared by escalation. */
  escalated: boolean;
  /** Every open finding for this title. Bounded by how many codes exist. */
  findings: MediaAttentionItem[];
}

export interface MediaAttentionGroupedResult {
  groups: MediaAttentionGroup[];
  /** Distinct TITLES, not findings — the thing being paged. */
  total: number;
  page: number;
  pageSize: number;
}

/** The views the queue can present. Each has its own honest empty state. */
export const MEDIA_ATTENTION_VIEWS = ['active', 'snoozed', 'dismissed', 'resolved'] as const;
export type MediaAttentionView = (typeof MEDIA_ATTENTION_VIEWS)[number];
