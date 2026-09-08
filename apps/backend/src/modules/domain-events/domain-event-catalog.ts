import { DOMAIN_EVENTS, type DomainEventDefinition } from '@ultratorrent/shared';

/**
 * Every event the platform may publish, with its payload contract.
 *
 * The catalogue is the gate: `DomainEventBus.publish()` refuses an unregistered
 * key. That is what stops the vocabulary drifting into a pile of ad-hoc strings
 * that nothing can subscribe to with confidence.
 *
 * `requiredFields` names only what a *consumer* genuinely needs — enough to route
 * the event and render a sentence about it. Listing every field a producer
 * happens to send would make the contract brittle for no benefit.
 */
const DEFINITIONS: readonly DomainEventDefinition[] = [
  // --- Files ---------------------------------------------------------------
  {
    key: DOMAIN_EVENTS.FILE_MOVED,
    description: 'A file was renamed or moved on disk, by any subsystem.',
    // Both paths, because a consumer's whole job is to follow the file.
    requiredFields: ['from', 'to'],
  },
  {
    key: DOMAIN_EVENTS.FILE_DELETED,
    description: 'A file was removed from disk (trashed or permanently).',
    requiredFields: ['path'],
  },
  // --- Torrent Activity Scheduler ------------------------------------------
  {
    key: DOMAIN_EVENTS.TORRENT_SCHEDULER_MODE_CHANGED,
    description: 'An engine moved between native, observe-only and managed scheduling.',
    // No dedupe: an operator changing the mode is a discrete act, and two
    // changes in a minute are two facts worth hearing about.
    requiredFields: ['engineId', 'mode'],
  },
  {
    key: DOMAIN_EVENTS.TORRENT_SCHEDULER_HEALTH_CHANGED,
    description: "An engine's scheduler health changed (healthy, degraded, limited).",
    requiredFields: ['engineId', 'healthState'],
    // Published only when the state DIFFERS from the stored one, so this window
    // is a second line of defence rather than the mechanism.
    deduplicationWindowSeconds: 600,
  },
  {
    key: DOMAIN_EVENTS.TORRENT_SCHEDULER_SEED_TARGET_REACHED,
    description: 'A torrent met its seeding target and the scheduler acted on it.',
    requiredFields: ['engineId', 'torrentHash'],
    /*
     * The important one. The sweep re-derives this every minute for as long as
     * the torrent remains complete, so without a window a finished seed would
     * announce itself forever. An hour is long enough that a rule firing on it
     * runs once per torrent in practice.
     */
    deduplicationWindowSeconds: 3600,
  },
  {
    key: DOMAIN_EVENTS.TORRENT_SCHEDULER_ACTION_FAILED,
    description: 'The scheduler could not apply a pause or resume it had planned.',
    requiredFields: ['engineId', 'torrentHash', 'action'],
    // A persistently failing action would otherwise alert every minute.
    deduplicationWindowSeconds: 900,
  },

  // --- Playback ------------------------------------------------------------
  {
    key: DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING,
    description: 'A media-server user began playing something.',
    requiredFields: ['mediaTitle', 'serverName'],
    // A session poll runs every 15s; without this a paused-and-resumed session
    // could republish the same start.
    deduplicationWindowSeconds: 300,
  },
  {
    key: DOMAIN_EVENTS.MEDIA_SERVER_USER_STOPPED_WATCHING,
    description: 'A media-server playback session ended.',
    requiredFields: ['mediaTitle', 'serverName'],
    deduplicationWindowSeconds: 300,
  },
  {
    key: DOMAIN_EVENTS.MEDIA_SERVER_REFRESH_FAILED,
    description: 'A media-server library refresh failed.',
    requiredFields: ['serverName'],
    deduplicationWindowSeconds: 900,
  },

  // --- Torrents ------------------------------------------------------------
  {
    key: DOMAIN_EVENTS.TORRENT_COMPLETED,
    description: 'A download reached 100%.',
    requiredFields: ['torrentName', 'hash'],
  },
  {
    key: DOMAIN_EVENTS.TORRENT_FAILED,
    description: 'A torrent entered the error state.',
    requiredFields: ['torrentName', 'hash'],
    // The sync loop sees the error state on every tick until it is resolved.
    deduplicationWindowSeconds: 3600,
  },

  // --- Library cleanup ------------------------------------------------------
  {
    key: DOMAIN_EVENTS.LIBRARY_CLEANUP_SEEDING_UNVERIFIED,
    description:
      'A purge left media in place because the torrent engine could not be reached to confirm whether it is still seeding.',
    requiredFields: ['planId', 'skipped'],
    /*
     * Six hours. An unreachable engine usually stays unreachable for a while,
     * and every scheduled run in that window would otherwise raise the same
     * alert — which is how a warning becomes something people filter out.
     */
    deduplicationWindowSeconds: 21600,
  },

  // --- Media Discovery -----------------------------------------------------
  {
    key: DOMAIN_EVENTS.MEDIA_DISCOVERY_AUTO_MONITORED,
    description:
      'A discovered title is now being monitored automatically: a watchlist entry and an acquisition rule were created without being asked.',
    requiredFields: ['title', 'templateName'],
    /*
     * No deduplication window. Each event is a DIFFERENT title, so collapsing
     * them would hide acquisitions rather than reduce noise — and the volume is
     * already bounded by the template's automatic-add limit, which is the right
     * place to pace this.
     */
    deduplicationWindowSeconds: 0,
  },
  {
    key: DOMAIN_EVENTS.MEDIA_DISCOVERY_REVIEW_REQUIRED,
    description:
      'An evaluation run left titles that need a person: an unresolved identity, or an automatic-add limit already spent.',
    requiredFields: ['count', 'templateName'],
    /*
     * Summarised per RUN and deduplicated for six hours. One event per held
     * title would fire twenty times on a first run, all saying the same thing
     * and all answered by the same visit to the inbox.
     */
    deduplicationWindowSeconds: 21600,
  },
  {
    key: DOMAIN_EVENTS.MEDIA_DISCOVERY_RULE_FAILED,
    description:
      'A title is monitored but its acquisition rule could not be generated, so it has no release preferences of its own.',
    requiredFields: ['title', 'reason'],
    // Per title, and rare: each one is a real fault with its own cause.
    deduplicationWindowSeconds: 0,
  },
  {
    key: DOMAIN_EVENTS.MEDIA_DISCOVERY_RETRACTED,
    description:
      'A monitored title stopped qualifying for its template, so its generated rule was deleted and its watchlist entry archived. Downloaded media and torrents are never touched.',
    requiredFields: ['title', 'templateName'],
    /*
     * Per title and never summarised. This UNDOES something the system did on
     * the operator's behalf, and a person who finds a show no longer being
     * acquired needs to be able to find out why — a count would not tell them
     * which show.
     */
    deduplicationWindowSeconds: 0,
  },
  {
    key: DOMAIN_EVENTS.MEDIA_DISCOVERY_GRADUATED,
    description:
      'A monitored title grabbed its first release and left the discovery catalogue. Its generated rule and watchlist entry are untouched — it is an ordinary acquisition from here, managed from RSS Feeds.',
    requiredFields: ['title'],
    /*
     * Per title, like a retraction, and for the same reason: a show vanishing
     * from Discover is a question waiting to be asked, and a count would not say
     * which show. Unlike a retraction it takes nothing away, so it is filed as
     * information rather than as a warning.
     */
    deduplicationWindowSeconds: 0,
  },
  {
    key: DOMAIN_EVENTS.MEDIA_DISCOVERY_PROVIDER_SYNC_FAILED,
    description:
      "A discovery provider's catalogue refresh failed. The previous catalogue was kept rather than emptied.",
    requiredFields: ['provider', 'reason'],
    // A broken provider stays broken, and the sweep retries every six hours.
    deduplicationWindowSeconds: 21600,
  },

  // --- Storage -------------------------------------------------------------
  {
    key: DOMAIN_EVENTS.SYSTEM_STORAGE_WARNING,
    description: 'A storage root dropped below the warning threshold.',
    requiredFields: ['path', 'freePercent'],
    deduplicationWindowSeconds: 21600,
  },
  {
    key: DOMAIN_EVENTS.SYSTEM_STORAGE_CRITICAL,
    description: 'A storage root dropped below the critical threshold.',
    requiredFields: ['path', 'freePercent'],
    deduplicationWindowSeconds: 21600,
  },
  {
    key: DOMAIN_EVENTS.SYSTEM_STORAGE_RECOVERED,
    description: 'A storage root returned above its thresholds.',
    requiredFields: ['path', 'freePercent'],
  },

  // --- Workflows -----------------------------------------------------------
  {
    key: DOMAIN_EVENTS.WORKFLOW_APPROVAL_REQUESTED,
    description: 'A workflow execution is waiting for a human decision.',
    requiredFields: ['workflowName', 'executionId'],
  },
  {
    key: DOMAIN_EVENTS.WORKFLOW_EXECUTION_FAILED,
    description: 'A workflow execution failed.',
    requiredFields: ['workflowName', 'executionId'],
  },
  {
    key: DOMAIN_EVENTS.WORKFLOW_EXECUTION_COMPLETED,
    description: 'A workflow execution completed.',
    requiredFields: ['workflowName', 'executionId'],
  },

  // --- Providers -----------------------------------------------------------
  {
    key: DOMAIN_EVENTS.PROVIDER_OFFLINE,
    description: 'A provider (torrent engine, indexer, media server) went offline.',
    requiredFields: ['providerName'],
    deduplicationWindowSeconds: 3600,
  },
  {
    key: DOMAIN_EVENTS.PROVIDER_RECOVERED,
    description: 'A provider came back online.',
    requiredFields: ['providerName'],
  },

  // --- Security ------------------------------------------------------------
  {
    key: DOMAIN_EVENTS.SECURITY_LOGIN_FAILED,
    description: 'A sign-in attempt failed.',
    requiredFields: ['username'],
    deduplicationWindowSeconds: 300,
  },
  {
    key: DOMAIN_EVENTS.SECURITY_PASSWORD_CHANGED,
    description: 'An account password was changed.',
    requiredFields: [],
  },
  {
    key: DOMAIN_EVENTS.SECURITY_API_KEY_CREATED,
    description: 'An API key was issued.',
    requiredFields: ['keyName'],
  },
  {
    key: DOMAIN_EVENTS.SECURITY_TWO_FACTOR_DISABLED,
    description: 'Two-factor authentication was turned off for an account.',
    requiredFields: [],
  },

  // --- Users ---------------------------------------------------------------
  {
    key: DOMAIN_EVENTS.USER_CREATED,
    description: 'A user account was created.',
    requiredFields: ['username'],
  },
  {
    key: DOMAIN_EVENTS.USER_ROLE_CHANGED,
    description: "A user's roles changed.",
    requiredFields: ['username'],
  },
] as const;

const BY_KEY = new Map(DEFINITIONS.map((d) => [d.key, d]));

export function getDomainEventDefinition(key: string): DomainEventDefinition | undefined {
  return BY_KEY.get(key);
}

export function allDomainEventDefinitions(): readonly DomainEventDefinition[] {
  return DEFINITIONS;
}

export function isRegisteredDomainEvent(key: string): boolean {
  return BY_KEY.has(key);
}
