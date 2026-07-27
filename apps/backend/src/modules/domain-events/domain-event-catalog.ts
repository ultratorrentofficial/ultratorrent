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
