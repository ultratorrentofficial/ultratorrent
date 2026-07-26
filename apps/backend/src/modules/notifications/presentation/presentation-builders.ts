import {
  DOMAIN_EVENTS,
  PRESENTATION_VERSION,
  avatarFor,
  formatDuration,
  formatMediaLabel,
  formatMediaParts,
  splitDuration,
  type DomainEventEnvelope,
  type NotificationEventDefinition,
  type NotificationPresentation,
  type PresentationFact,
} from '@ultratorrent/shared';
import { formatWhen, s, type PresentationLocale } from './presentation-strings';
import { DEFAULT_COMPLETION_THRESHOLD_PERCENT } from '../../media/cleanup/domain/playback-aggregate';

/**
 * Everything a builder may consider.
 *
 * `canViewPlaybackDetail` is resolved by the caller and passed in rather than
 * looked up here, so a builder cannot run without a permission decision having
 * been made — omitting it is a type error, not a silent `false` that hides
 * artwork or a silent `true` that leaks it.
 */
export interface PresentationContext {
  definition: NotificationEventDefinition;
  envelope: DomainEventEnvelope;
  locale: PresentationLocale;
  timezone: string | null;
  canViewPlaybackDetail: boolean;
  /** The notification row id, once known. Null during a preview. */
  notificationId: string | null;
}

export type PresentationBuilder = (ctx: PresentationContext) => NotificationPresentation | null;

/* ------------------------------------------------------------------ helpers */

function str(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

/** Numbers arrive as strings from some providers, so coerce rather than reject. */
function num(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

const clampPercent = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

/**
 * Below this, a "start" really is a start.
 *
 * Media servers report a second or two of offset on a genuine start, and a
 * player that restores position reports a few percent. Calling those "resumed"
 * would be wrong far more often than it was right.
 */
const RESUME_THRESHOLD_PERCENT = 5;

/**
 * "1h 09m" or "24 min", in the recipient's language.
 *
 * Minutes are zero-padded only when hours precede them, so "1h 09m" lines up
 * while a bare "9 min" does not read as a clock.
 */
function watchedLabel(seconds: number, locale: PresentationLocale): string | null {
  const { hours, minutes } = splitDuration(seconds);
  if (!hours && !minutes) return null; // under 30s — saying "0 min" is noise
  return hours
    ? s('durationHoursMinutes', locale, { hours, minutes: String(minutes).padStart(2, '0') })
    : s('durationMinutes', locale, { minutes });
}

/**
 * "4K HDR", "1080p" — a summary, never the raw stream description.
 *
 * Providers report resolution inconsistently ("4k", "2160", "1080p"), so it is
 * normalized rather than passed through. Dolby Vision and HDR10 both collapse to
 * "HDR": the distinction matters to a transcoding decision, not to someone
 * reading a phone notification.
 */
function qualitySummary(resolution: string | null, dynamicRange: string | null): string | null {
  const raw = (resolution ?? '').trim().toLowerCase();
  let res: string | null = null;
  if (raw) {
    if (raw === '4k' || raw === '2160' || raw === '2160p' || raw === 'uhd') res = '4K';
    else if (/^\d+$/.test(raw)) res = `${raw}p`;
    else res = raw.replace(/^(\d+)p$/, '$1p').toUpperCase() === raw.toUpperCase() && /p$/.test(raw)
      ? raw
      : raw.toUpperCase();
  }

  const range = (dynamicRange ?? '').trim().toLowerCase();
  const hdr = range && range !== 'sdr' ? 'HDR' : null;

  return [res, hdr].filter(Boolean).join(' ') || null;
}

/* ---------------------------------------------------------------- playback */

/**
 * Started / stopped watching.
 *
 * One builder for both because they are the same card in a different tone —
 * identical layout and field resolution, differing only in accent, verb and
 * whether progress is meaningful. Splitting them would duplicate the media-label
 * and avatar logic and let the two drift.
 *
 * Two privacy rules live here rather than in renderers:
 *
 * - **Artwork and device detail need `view_live_activity`.** Watching habits are
 *   personal, and a notification reaches someone who never opened the dashboard.
 * - **`ipAddress` is never read**, at any permission level. There is no card that
 *   needs it, so the builder has no path to it rather than a condition a later
 *   edit could invert.
 */
const buildPlayback: PresentationBuilder = (ctx) => {
  const { envelope, locale, timezone } = ctx;
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  const started = envelope.eventKey === DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING;

  const title = str(payload, 'mediaTitle');
  if (!title) return null; // no card is better than "undefined"

  const showTitle = str(payload, 'showTitle');
  const seasonNumber = num(payload, 'seasonNumber');
  const episodeNumber = num(payload, 'episodeNumber');
  const isEpisode = !!showTitle && seasonNumber != null && episodeNumber != null;

  const mediaLabel = formatMediaLabel({
    title, showTitle, seasonNumber, episodeNumber, year: num(payload, 'year'),
  });

  // The same facts, split into two display lines. Computed once here so every
  // channel renders the same title — a renderer formatting its own would drift.
  const mediaType = str(payload, 'mediaType');
  const media = formatMediaParts({
    title, showTitle, episodeTitle: str(payload, 'episodeTitle'),
    seasonNumber, episodeNumber, year: num(payload, 'year'), mediaType,
  });

  // Identity is playback detail too. Watching habits are personal, and the name
  // is the most personal part of them — gating artwork while naming the person
  // would be the wrong half. Without the permission the clause still reads:
  // "A user started watching".
  const realName = str(payload, 'userDisplayName');
  const userName = ctx.canViewPlaybackDetail
    ? realName ?? s('someone', locale)
    : s('aUser', locale);
  const when = str(payload, started ? 'startedAt' : 'stoppedAt') ?? envelope.occurredAt;

  const facts: PresentationFact[] = [
    { icon: 'user', label: s('fieldUser', locale), value: userName },
    {
      icon: isEpisode ? 'tv' : 'film',
      label: s(isEpisode ? 'fieldEpisode' : 'fieldMedia', locale),
      value: mediaLabel,
    },
    { icon: 'clock', label: s('fieldTime', locale), value: formatWhen(when, locale, timezone) },
  ];

  // Device and quality are playback detail — same gate as the dashboard.
  if (ctx.canViewPlaybackDetail) {
    const player = [str(payload, 'client'), str(payload, 'device')].filter(Boolean).join(' · ');
    if (player) facts.push({ icon: 'monitor', label: s('fieldPlayer', locale), value: player });
    const quality = [str(payload, 'resolution'), str(payload, 'playbackMethod')].filter(Boolean).join(' · ');
    if (quality) facts.push({ icon: 'gauge', label: s('fieldQuality', locale), value: quality });
  }

  // Progress belongs on the stop card: "42% watched" answers "did they finish?".
  // On a start card it is always ~0 and says nothing.
  const rawPercent = num(payload, started ? 'progressPercent' : 'completionPercent');
  const percent = rawPercent == null ? null : clampPercent(rawPercent);
  const watchedSeconds = num(payload, 'watchedSeconds');

  const progress = !started && percent != null
    ? { percent, label: s('percentWatched', locale, { percent }), positionLabel: null }
    : null;

  if (progress) {
    facts.push({ icon: 'percent', label: s('fieldProgress', locale), value: progress.label });
  }
  if (!started && watchedSeconds != null && watchedSeconds > 0) {
    facts.push({
      icon: 'clock',
      label: s('fieldTime', locale),
      value: s('watchedFor', locale, { duration: formatDuration(watchedSeconds) }),
    });
  }

  // Artwork is a reference. A stopped card outlives its session — the row is
  // deleted the instant playback ends — so live-session art would 404 on exactly
  // the card that needs it; the notification-scoped proxy re-fetches instead.
  const hasArt = !!str(payload, 'artPath') && !!str(payload, 'connectionId');
  const artwork = ctx.canViewPlaybackDetail && hasArt && ctx.notificationId
    ? {
        kind: 'notification' as const,
        id: ctx.notificationId,
        aspect: 'poster' as const,
        alt: s('posterAlt', locale, { title: mediaLabel }),
        mediaType: str(payload, 'mediaType'),
      }
    : null;

  // A "start" that begins part-way through is a resume. The producer publishes one
  // event for both, and the distinction is visible only in the progress it carries
  // — so it is derived here rather than invented as a second event.
  const startPercent = started && rawPercent != null ? clampPercent(rawPercent) : null;
  const resumed = startPercent != null && startPercent >= RESUME_THRESHOLD_PERCENT;

  // "Finished" is a claim about the session, so it uses the platform's existing
  // completion threshold rather than a second definition that could drift from
  // the one the cleanup aggregates already rely on.
  const completed = !started && percent != null && percent >= DEFAULT_COMPLETION_THRESHOLD_PERCENT;

  const listening = media.kind === 'music' || media.kind === 'audiobook';
  const phrase = s(
    started
      ? resumed
        ? listening ? 'resumedListeningPhrase' : 'resumedWatchingPhrase'
        : listening ? 'startedListeningPhrase' : 'startedWatchingPhrase'
      : completed
        ? listening ? 'finishedListeningPhrase' : 'finishedWatchingPhrase'
        : listening ? 'stoppedListeningPhrase' : 'stoppedWatchingPhrase',
    locale,
    { name: userName, media: mediaLabel },
  );

  // One short context line, at most two facts. Priority: resume progress, then a
  // quality summary, then the device. More than two reads as a spec sheet, which
  // is the format this replaces.
  const contextParts: string[] = [];
  if (ctx.canViewPlaybackDetail) {
    // Progress is playback detail like the rest. Reporting how far through
    // someone was, while withholding their name and device, would leak the more
    // personal half of the same fact.
    if (resumed) contextParts.push(s('resumedAt', locale, { percent: startPercent! }));
    if (contextParts.length < 2) {
      const q = qualitySummary(str(payload, 'resolution'), str(payload, 'videoDynamicRange'));
      if (q) contextParts.push(q);
    }
    if (contextParts.length < 2) {
      const where = str(payload, 'device') ?? str(payload, 'client');
      if (where) contextParts.push(where);
    }
  }
  /*
   * A stopped session answers "did they finish, and how long were they in?" —
   * so its context line is progress and duration, not resolution and device.
   * Priority: completed state, then progress, then duration, and the device only
   * when there is no progress at all to report.
   */
  if (!started) {
    contextParts.length = 0;
    if (ctx.canViewPlaybackDetail) {
      if (completed) contextParts.push(s('completedState', locale));
      else if (percent != null) contextParts.push(s('percentWatchedShort', locale, { percent }));

      const duration = watchedSeconds != null && watchedSeconds > 0
        ? watchedLabel(watchedSeconds, locale)
        : null;
      if (duration && contextParts.length < 2) contextParts.push(duration);

      // Only when progress data is missing entirely does the device earn a slot.
      if (!contextParts.length) {
        const where = str(payload, 'device') ?? str(payload, 'client');
        if (where) contextParts.push(where);
      }
    }
  }

  const context = contextParts.length ? contextParts.join(' • ') : null;

  const playbackState = str(payload, 'playbackState');
  const status = started
    ? s(playbackState === 'paused' ? 'paused' : playbackState === 'buffering' ? 'buffering' : 'nowPlaying', locale)
    : progress?.label ?? null;

  return {
    version: PRESENTATION_VERSION,
    eventKey: envelope.eventKey,
    // `stopped` is not `error`: playback ending is red in the design, but it is
    // a normal event and must not carry a failure icon.
    accent: started ? 'started' : 'stopped',
    icon: started ? 'play' : 'stop',
    headline: {
      lead: s(started ? 'startedLead' : 'stoppedLead', locale),
      trail: s(started ? 'startedTrail' : 'stoppedTrail', locale),
    },
    summary: {
      // `emphasis` must be a substring of `text` for splitSummary to find it, so
      // the start phrase is completed with the media label here. Compact channels
      // read `media`/`context` instead and never re-join these.
      text: `${phrase} ${mediaLabel}`,
      emphasis: mediaLabel,
    },
    avatar: avatarFor(userName),
    artwork,
    media,
    context,
    facts,
    progress,
    status,
    action: {
      // Exactly one. The destination re-authorizes on arrival, so this is a hint,
      // never a capability — and it is a literal, never payload-derived.
      label: s(started ? 'viewLiveActivity' : 'viewActivity', locale),
      href: started ? '/media-server-analytics/live' : '/media-server-analytics/watch-history',
      icon: started ? 'monitor' : 'activity',
    },
    timestamp: when,
  };
};

/* ---------------------------------------------------------------- torrents */

const buildTorrent: PresentationBuilder = (ctx) => {
  const { envelope, locale, timezone } = ctx;
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  const name = str(payload, 'torrentName');
  if (!name) return null;

  const completed = envelope.eventKey === DOMAIN_EVENTS.TORRENT_COMPLETED;
  const facts: PresentationFact[] = [
    { icon: 'download', label: s('fieldMedia', locale), value: name },
    { icon: 'clock', label: s('fieldTime', locale), value: formatWhen(envelope.occurredAt, locale, timezone) },
  ];
  const reason = str(payload, 'reason');
  if (!completed && reason) facts.push({ icon: 'alert', label: s('fieldReason', locale), value: reason });

  return {
    version: PRESENTATION_VERSION,
    eventKey: envelope.eventKey,
    accent: completed ? 'success' : 'error',
    icon: completed ? 'download' : 'alert',
    headline: {
      lead: s(completed ? 'downloadCompleteLead' : 'downloadFailedLead', locale),
      trail: s(completed ? 'downloadCompleteTrail' : 'downloadFailedTrail', locale),
    },
    summary: {
      text: s(completed ? 'torrentCompletedSummary' : 'torrentFailedSummary', locale, { name }),
      emphasis: name,
    },
    avatar: null,
    artwork: null,
    facts,
    progress: null,
    status: null,
    action: { label: s('viewTorrents', locale), href: '/torrents', icon: 'download' },
    timestamp: envelope.occurredAt,
  };
};

/* ----------------------------------------------------------------- storage */

const buildStorage: PresentationBuilder = (ctx) => {
  const { envelope, locale, timezone } = ctx;
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  const path = str(payload, 'path');
  const freePercent = num(payload, 'freePercent');
  if (!path || freePercent == null) return null;

  const critical = envelope.eventKey === DOMAIN_EVENTS.SYSTEM_STORAGE_CRITICAL;
  const recovered = envelope.eventKey === DOMAIN_EVENTS.SYSTEM_STORAGE_RECOVERED;
  const percent = clampPercent(freePercent);

  return {
    version: PRESENTATION_VERSION,
    eventKey: envelope.eventKey,
    accent: recovered ? 'success' : critical ? 'error' : 'warning',
    icon: 'disk',
    headline: {
      lead: s('storageLead', locale),
      trail: s(recovered ? 'storageRecoveredTrail' : critical ? 'storageCriticalTrail' : 'storageWarningTrail', locale),
    },
    summary: { text: s('storageSummary', locale, { path, percent }), emphasis: path },
    avatar: null,
    artwork: null,
    facts: [
      { icon: 'disk', label: s('fieldLocation', locale), value: path },
      { icon: 'gauge', label: s('fieldFree', locale), value: `${percent}%` },
      { icon: 'clock', label: s('fieldTime', locale), value: formatWhen(envelope.occurredAt, locale, timezone) },
    ],
    // Free space, not used space — the bar reads as "how much room is left".
    progress: { percent, label: `${percent}%`, positionLabel: null },
    status: null,
    action: { label: s('viewStorage', locale), href: '/system', icon: 'disk' },
    timestamp: envelope.occurredAt,
  };
};

/* --------------------------------------------------------------- workflows */

const buildWorkflow: PresentationBuilder = (ctx) => {
  const { envelope, locale, timezone } = ctx;
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  const name = str(payload, 'workflowName');
  if (!name) return null;

  const key = envelope.eventKey;
  const approval = key === DOMAIN_EVENTS.WORKFLOW_APPROVAL_REQUESTED;
  const failed = key === DOMAIN_EVENTS.WORKFLOW_EXECUTION_FAILED;

  return {
    version: PRESENTATION_VERSION,
    eventKey: key,
    accent: approval ? 'warning' : failed ? 'error' : 'success',
    icon: 'workflow',
    headline: {
      lead: s('workflowLead', locale),
      trail: s(approval ? 'workflowApprovalTrail' : failed ? 'workflowFailedTrail' : 'workflowCompletedTrail', locale),
    },
    summary: {
      text: s(approval ? 'workflowApprovalSummary' : failed ? 'workflowFailedSummary' : 'workflowCompletedSummary', locale, { name }),
      emphasis: name,
    },
    avatar: null,
    artwork: null,
    facts: [
      { icon: 'workflow', label: s('fieldWorkflow', locale), value: name },
      { icon: 'clock', label: s('fieldTime', locale), value: formatWhen(envelope.occurredAt, locale, timezone) },
    ],
    progress: null,
    status: null,
    action: {
      label: s('reviewWorkflow', locale),
      href: approval ? '/workflows/approvals' : '/workflows',
      icon: 'workflow',
    },
    timestamp: envelope.occurredAt,
  };
};

/* --------------------------------------------------------------- providers */

const buildProvider: PresentationBuilder = (ctx) => {
  const { envelope, locale, timezone } = ctx;
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  const name = str(payload, 'providerName') ?? str(payload, 'serverName');
  if (!name) return null;

  const key = envelope.eventKey;
  const recovered = key === DOMAIN_EVENTS.PROVIDER_RECOVERED;
  const refreshFailed = key === DOMAIN_EVENTS.MEDIA_SERVER_REFRESH_FAILED;

  return {
    version: PRESENTATION_VERSION,
    eventKey: key,
    accent: recovered ? 'success' : refreshFailed ? 'warning' : 'error',
    icon: 'plug',
    headline: {
      lead: s('providerLead', locale),
      trail: s(recovered ? 'providerRecoveredTrail' : refreshFailed ? 'refreshFailedTrail' : 'providerOfflineTrail', locale),
    },
    summary: {
      text: s(recovered ? 'providerRecoveredSummary' : refreshFailed ? 'refreshFailedSummary' : 'providerOfflineSummary', locale, { name }),
      emphasis: name,
    },
    avatar: null,
    artwork: null,
    facts: [
      { icon: 'server', label: s('fieldServer', locale), value: name },
      { icon: 'clock', label: s('fieldTime', locale), value: formatWhen(envelope.occurredAt, locale, timezone) },
    ],
    progress: null,
    status: null,
    action: { label: s('viewProviders', locale), href: '/engines', icon: 'plug' },
    timestamp: envelope.occurredAt,
  };
};

/* ---------------------------------------------------------- security/users */

const buildSecurity: PresentationBuilder = (ctx) => {
  const { envelope, locale, timezone } = ctx;
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  const key = envelope.eventKey;

  const trail =
    key === DOMAIN_EVENTS.SECURITY_PASSWORD_CHANGED ? 'passwordChangedTrail'
    : key === DOMAIN_EVENTS.SECURITY_TWO_FACTOR_DISABLED ? 'twoFactorDisabledTrail'
    : key === DOMAIN_EVENTS.SECURITY_API_KEY_CREATED ? 'apiKeyCreatedTrail'
    : 'loginFailedTrail';

  // A person is named by their full name; the login handle is the fallback for an
  // account that never set one.
  const name = str(payload, 'keyName') ?? str(payload, 'displayName') ?? str(payload, 'username') ?? '';
  const summaryKey =
    key === DOMAIN_EVENTS.SECURITY_PASSWORD_CHANGED ? 'passwordChangedSummary'
    : key === DOMAIN_EVENTS.SECURITY_TWO_FACTOR_DISABLED ? 'twoFactorDisabledSummary'
    : key === DOMAIN_EVENTS.SECURITY_API_KEY_CREATED ? 'apiKeyCreatedSummary'
    : 'loginFailedSummary';

  const facts: PresentationFact[] = [
    { icon: 'clock', label: s('fieldTime', locale), value: formatWhen(envelope.occurredAt, locale, timezone) },
  ];
  if (name) facts.unshift({ icon: 'shield', label: s('fieldAccount', locale), value: name });

  return {
    version: PRESENTATION_VERSION,
    eventKey: key,
    // Every security event is at least a warning: they exist to be noticed.
    accent: 'warning',
    icon: 'shield',
    headline: { lead: s('securityLead', locale), trail: s(trail, locale) },
    summary: { text: s(summaryKey, locale, { name }), emphasis: name || null },
    avatar: null,
    artwork: null,
    facts,
    progress: null,
    status: null,
    action: { label: s('reviewAccount', locale), href: '/account', icon: 'shield' },
    timestamp: envelope.occurredAt,
  };
};

const buildUser: PresentationBuilder = (ctx) => {
  const { envelope, locale, timezone } = ctx;
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  const name = str(payload, 'displayName') ?? str(payload, 'username');
  if (!name) return null;

  const created = envelope.eventKey === DOMAIN_EVENTS.USER_CREATED;
  return {
    version: PRESENTATION_VERSION,
    eventKey: envelope.eventKey,
    accent: created ? 'neutral' : 'warning',
    icon: 'user',
    headline: {
      lead: s('userLead', locale),
      trail: s(created ? 'userCreatedTrail' : 'userRoleChangedTrail', locale),
    },
    summary: {
      text: s(created ? 'userCreatedSummary' : 'userRoleChangedSummary', locale, { name }),
      emphasis: name,
    },
    avatar: avatarFor(name),
    artwork: null,
    facts: [
      { icon: 'user', label: s('fieldAccount', locale), value: name },
      { icon: 'clock', label: s('fieldTime', locale), value: formatWhen(envelope.occurredAt, locale, timezone) },
    ],
    progress: null,
    status: null,
    action: { label: s('viewUsers', locale), href: '/users', icon: 'user' },
    timestamp: envelope.occurredAt,
  };
};

/* -------------------------------------------------------------- the registry */

/**
 * `presentationBuilder` name → builder.
 *
 * A registry rather than a switch so the catalogue names its builder and an
 * event without one degrades to plain text instead of failing.
 */
const BUILDERS: Record<string, PresentationBuilder> = {
  playback: buildPlayback,
  torrent: buildTorrent,
  storage: buildStorage,
  workflow: buildWorkflow,
  provider: buildProvider,
  security: buildSecurity,
  user: buildUser,
};

export function hasPresentationBuilder(name: string): boolean {
  return name in BUILDERS;
}

export function registeredBuilderNames(): string[] {
  return Object.keys(BUILDERS).sort();
}

/**
 * Build a presentation, or null.
 *
 * A builder that throws is contained here: a malformed payload must degrade the
 * *card*, never the notification. Losing a notification because its poster could
 * not be resolved is a far worse outcome than an unstyled one.
 */
export function buildPresentation(ctx: PresentationContext): NotificationPresentation | null {
  const builder = BUILDERS[ctx.definition.presentationBuilder];
  if (!builder) return null;
  try {
    return builder(ctx);
  } catch {
    return null;
  }
}
