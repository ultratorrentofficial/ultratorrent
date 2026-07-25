import type { DomainEventEnvelope, NotificationEventDefinition } from '@ultratorrent/shared';

export interface StoredPresentation {
  title: string;
  body: string | null;
  deepLink: string | null;
}

/**
 * Payload fields worth putting in a notification, most specific first.
 *
 * An allow-list, not a dump of the payload: a producer that later adds a field
 * cannot leak it into someone's inbox by accident.
 */
const TITLE_FIELDS = [
  'mediaTitle',
  'torrentName',
  'workflowName',
  'providerName',
  'serverName',
  'username',
  'keyName',
  'path',
] as const;

/** Names that must never be rendered, even if a producer allow-lists one. */
const NEVER_RENDER = /token|secret|password|apikey|webhook|chatid|ipaddress/i;

/**
 * Deep links, per event namespace.
 *
 * Built **server-side from a fixed map**, never from the payload — a link taken
 * from event data is a redirect a producer could point anywhere. The route
 * re-authorizes on arrival, so this is a hint, never a capability.
 */
const DEEP_LINKS: Record<string, string> = {
  media_server: '/media-server-analytics',
  torrent: '/torrents',
  system: '/system',
  workflow: '/workflows',
  provider: '/engines',
  security: '/account',
  user: '/users',
};

function humanize(key: string): string {
  const words = key.split('.').slice(1).join(' ').replace(/[._]+/g, ' ').trim();
  if (!words) return key;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The plain fallback: a readable title, a short body, a safe deep link.
 *
 * Reached when a rich builder DECLINES — a playback event with no media title, a
 * torrent event with no name. The rich model is the normal path; this exists so
 * that a malformed payload still produces something legible rather than a raw
 * event key, which is exactly what the previous engine shipped for months.
 *
 * The rendered strings are **stored**, so a notification says the same thing
 * forever. Re-rendering historical rows against a changed catalogue would
 * silently rewrite the past.
 */
export function buildFallbackPresentation(
  definition: NotificationEventDefinition,
  envelope: DomainEventEnvelope,
): StoredPresentation {
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;

  let subject: string | null = null;
  for (const field of TITLE_FIELDS) {
    if (NEVER_RENDER.test(field)) continue;
    const value = payload[field];
    if (typeof value === 'string' && value.trim()) {
      subject = value.trim();
      break;
    }
  }

  const action = humanize(definition.key);
  const title = subject ? `${action}: ${subject}` : action;

  const namespace = definition.key.split('.')[0];
  return {
    title: title.slice(0, 300),
    body: null,
    deepLink: DEEP_LINKS[namespace] ?? null,
  };
}
