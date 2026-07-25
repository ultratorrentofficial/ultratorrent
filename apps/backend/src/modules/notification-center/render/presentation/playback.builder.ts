import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_PRESENTATION_VERSION,
  avatarFor,
  formatMediaLabel,
  type NotificationPresentation,
  type PresentationFact,
} from '@ultratorrent/shared';
import type { PresentationBuilder, PresentationContext } from './presentation.types';
import { formatWhen, s } from './presentation-strings';

/** Read a string field, treating blank and non-string as absent. */
function str(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

/** Read a finite number field, tolerating the numeric strings some providers send. */
function num(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Build the started/stopped playback card.
 *
 * Both events share a builder because they are the same card with a different
 * tone: identical layout, identical field resolution, differing only in accent,
 * verb, and whether progress is meaningful. Splitting them would duplicate the
 * media-label and avatar logic and let the two drift.
 *
 * Two privacy rules are enforced here rather than left to renderers:
 *
 * - **Artwork and device detail require `view_live_activity`.** Watching habits
 *   are personal, and a notification is the one surface that reaches someone who
 *   never opened the dashboard.
 * - **`ipAddress` is never read**, at any permission level. It is on the session
 *   row and on the payload's source object, and there is no version of this card
 *   that needs it — so the safe thing is for the builder to have no path to it
 *   at all rather than a condition that could be inverted by a later edit.
 */
const buildPlayback: PresentationBuilder = (ctx: PresentationContext): NotificationPresentation | null => {
  const { payload, locale, timezone, eventKey } = ctx;
  const started = eventKey === NOTIFICATION_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING;

  // The title is the one field that must exist; without it there is no card
  // worth showing, and the plain-text fallback reads better than "undefined".
  const title = str(payload, 'mediaTitle') ?? str(payload, 'title');
  if (!title) return null;

  const showTitle = str(payload, 'showTitle');
  const seasonNumber = num(payload, 'seasonNumber');
  const episodeNumber = num(payload, 'episodeNumber');
  const isEpisode = !!showTitle && seasonNumber != null && episodeNumber != null;

  const mediaLabel = formatMediaLabel({
    title,
    showTitle,
    seasonNumber,
    episodeNumber,
    year: num(payload, 'year'),
  });

  const userName = str(payload, 'userDisplayName') ?? s('someone', locale);
  const when = str(payload, started ? 'startedAt' : 'stoppedAt') ?? ctx.at;

  const summaryText = s(started ? 'startedSummary' : 'stoppedSummary', locale, {
    name: userName,
    media: mediaLabel,
  });

  const facts: PresentationFact[] = [
    { icon: 'user', label: s('fieldUser', locale), value: userName },
    {
      icon: isEpisode ? 'tv' : 'film',
      label: s(isEpisode ? 'fieldEpisode' : 'fieldMedia', locale),
      value: mediaLabel,
    },
    { icon: 'clock', label: s('fieldTime', locale), value: formatWhen(when, locale, timezone) },
  ];

  // Progress belongs on the stop card: "42% watched" answers "did they finish
  // it?". On a start card it is always ~0 and says nothing — except on a resume,
  // which the payload cannot currently distinguish from a fresh start.
  const percentRaw = num(payload, started ? 'progressPercent' : 'completionPercent');
  const percent = percentRaw == null ? null : Math.min(100, Math.max(0, Math.round(percentRaw)));
  const progress =
    !started && percent != null
      ? { percent, label: s('percentWatched', locale, { percent }) }
      : null;
  if (progress) {
    facts.push({ icon: 'percent', label: s('fieldProgress', locale), value: progress.label });
  }

  // Artwork is referenced, never linked. After a session ends its row is deleted,
  // so a live-session reference would 404 on exactly the card that shows a
  // finished view — the notification-scoped proxy re-fetches from the provider
  // using the connection and art path recorded on this notification.
  const hasArt = !!str(payload, 'artPath') && !!str(payload, 'connectionId');
  const artwork =
    ctx.canViewLiveActivity && hasArt && ctx.notificationId
      ? {
          kind: 'notification' as const,
          id: ctx.notificationId,
          aspect: 'poster' as const,
          alt: s('posterAlt', locale, { title: mediaLabel }),
        }
      : null;

  const playbackState = str(payload, 'playbackState');
  const status = started
    ? s(playbackState === 'paused' ? 'paused' : 'nowPlaying', locale)
    : progress?.label ?? null;

  return {
    version: NOTIFICATION_PRESENTATION_VERSION,
    eventKey,
    accent: started ? 'positive' : 'negative',
    icon: started ? 'play' : 'stop',
    eyebrow: s('brand', locale),
    headline: {
      lead: s(started ? 'startedLead' : 'stoppedLead', locale),
      trail: s(started ? 'startedTrail' : 'stoppedTrail', locale),
    },
    summary: { text: summaryText, emphasis: mediaLabel },
    avatar: avatarFor(userName),
    artwork,
    facts,
    progress,
    status,
    action: {
      label: s(started ? 'viewDetails' : 'viewActivity', locale),
      href: started ? '/media-server/live' : '/media-server/history',
      icon: started ? 'monitor' : 'activity',
    },
    timestamp: when,
  };
};

export const PLAYBACK_PRESENTATION_BUILDERS: Record<string, PresentationBuilder> = {
  [NOTIFICATION_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING]: buildPlayback,
  [NOTIFICATION_EVENTS.MEDIA_SERVER_USER_FINISHED_WATCHING]: buildPlayback,
};
