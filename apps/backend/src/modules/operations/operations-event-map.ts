import {
  DOMAIN_EVENTS,
  PERMISSIONS,
  type DomainEventEnvelope,
  type OperationsSeverity,
} from '@ultratorrent/shared';

/**
 * How a platform event becomes one line of the console's narrative.
 *
 * This file is the whole security boundary of the event stream, and it is pure
 * on purpose: no Prisma, no gateway, no clock. Everything it decides —
 * who may read an event, what it says, and which facts travel with it — is a
 * function of the envelope, so it can be tested exhaustively without standing up
 * a module. The bridge that uses it does transport and nothing else.
 *
 * Three rules it enforces:
 *
 * 1. **Allowlist, never spread.** A mapping names the payload keys it wants.
 *    `{ ...payload }` would put whatever a producer adds tomorrow on the wire,
 *    and the first time that is a token nobody would notice.
 * 2. **An unmapped event does not travel.** Adding an event to the catalogue
 *    must not silently publish it to consoles; someone has to decide who may
 *    read it. Unmapped keys are dropped, and that is the safe direction.
 * 3. **The permission is the domain's own.** `console.view` gets you the
 *    stream; it never decides what is in it.
 */

/** What one event key becomes. */
export interface OperationsEventMapping {
  /**
   * The permission required to read it. `null` means every console socket —
   * used only for facts that are already public to any authenticated user.
   */
  permission: string | null;
  /** Coarse grouping the console filters by. */
  category: string;
  severity: OperationsSeverity;
  /** One line, present tense, no trailing period. */
  summary: (payload: Record<string, unknown>, envelope: DomainEventEnvelope) => string;
  /**
   * Payload keys allowed to travel as facts. Scalars only — a nested object is
   * dropped rather than flattened, because flattening is how a payload's
   * private corners end up on the wire one level down.
   */
  facts: string[];
}

/** A scalar payload value, or null if it is anything else. */
function scalar(value: unknown): string | number | boolean | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  return null;
}

function str(payload: Record<string, unknown>, key: string, fallback = 'unknown'): string {
  const value = scalar(payload[key]);
  return value === null ? fallback : String(value);
}

/**
 * The last path segment.
 *
 * File events carry absolute paths, and a narrative line is the wrong place for
 * one: it is unreadable at terminal width, and it discloses the layout of a host
 * to a reader who was granted "may see that files move", not "may see where".
 * The full path stays available over the file manager's own API, to whoever the
 * file manager already lets ask.
 */
function tail(value: unknown): string {
  const path = scalar(value);
  if (path === null) return 'a file';
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? String(path);
}

const MAPPINGS: Record<string, OperationsEventMapping> = {
  // --- Playback -------------------------------------------------------------
  /*
   * Gated on `view_live_activity`, not the analytics permission at large: this
   * says a named person is watching a named thing right now, which is precisely
   * the distinction that permission exists to draw. The viewer is deliberately
   * not in the facts — the summary names the title and the server, and a console
   * filtering by user is a reporting feature, not a stream one.
   */
  [DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING]: {
    permission: PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY,
    category: 'playback',
    severity: 'info',
    summary: (p) => `Playback started: ${str(p, 'mediaTitle', 'something')} on ${str(p, 'serverName', 'a media server')}`,
    facts: ['serverName', 'mediaType'],
  },
  [DOMAIN_EVENTS.MEDIA_SERVER_USER_STOPPED_WATCHING]: {
    permission: PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY,
    category: 'playback',
    severity: 'info',
    summary: (p) => `Playback stopped: ${str(p, 'mediaTitle', 'something')} on ${str(p, 'serverName', 'a media server')}`,
    facts: ['serverName', 'mediaType'],
  },
  [DOMAIN_EVENTS.MEDIA_SERVER_REFRESH_FAILED]: {
    permission: PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW,
    category: 'playback',
    severity: 'warning',
    summary: (p) => `Media server refresh failed: ${str(p, 'serverName', 'a media server')}`,
    facts: ['serverName'],
  },

  // --- Files ----------------------------------------------------------------
  [DOMAIN_EVENTS.FILE_MOVED]: {
    permission: PERMISSIONS.FILES_VIEW,
    category: 'files',
    severity: 'info',
    summary: (p) => `File moved: ${tail(p.from)} → ${tail(p.to)}`,
    facts: [],
  },
  [DOMAIN_EVENTS.FILE_DELETED]: {
    permission: PERMISSIONS.FILES_VIEW,
    category: 'files',
    severity: 'info',
    summary: (p) => `File deleted: ${tail(p.path)}`,
    facts: ['permanent'],
  },

  // --- Torrents -------------------------------------------------------------
  [DOMAIN_EVENTS.TORRENT_COMPLETED]: {
    permission: PERMISSIONS.TORRENTS_VIEW,
    category: 'torrent',
    severity: 'info',
    summary: (p) => `Download complete: ${str(p, 'name', 'a torrent')}`,
    facts: ['engineId'],
  },
  [DOMAIN_EVENTS.TORRENT_FAILED]: {
    permission: PERMISSIONS.TORRENTS_VIEW,
    category: 'torrent',
    severity: 'error',
    summary: (p) => `Download failed: ${str(p, 'name', 'a torrent')}`,
    facts: ['engineId', 'error'],
  },

  // --- Queue ----------------------------------------------------------------
  [DOMAIN_EVENTS.TORRENT_SCHEDULER_MODE_CHANGED]: {
    permission: PERMISSIONS.TORRENT_SCHEDULER_VIEW,
    category: 'queue',
    severity: 'info',
    summary: (p) => `Scheduler mode is now ${str(p, 'mode')} on engine ${str(p, 'engineId')}`,
    facts: ['engineId', 'mode'],
  },
  [DOMAIN_EVENTS.TORRENT_SCHEDULER_HEALTH_CHANGED]: {
    permission: PERMISSIONS.TORRENT_SCHEDULER_VIEW,
    category: 'queue',
    severity: 'warning',
    summary: (p) => `Scheduler health is ${str(p, 'healthState')} on engine ${str(p, 'engineId')}`,
    facts: ['engineId', 'healthState'],
  },
  [DOMAIN_EVENTS.TORRENT_SCHEDULER_SEED_TARGET_REACHED]: {
    permission: PERMISSIONS.TORRENT_SCHEDULER_VIEW,
    category: 'queue',
    severity: 'info',
    summary: (p) => `Seed target reached on engine ${str(p, 'engineId')}`,
    facts: ['engineId'],
  },
  [DOMAIN_EVENTS.TORRENT_SCHEDULER_ACTION_FAILED]: {
    permission: PERMISSIONS.TORRENT_SCHEDULER_VIEW,
    category: 'queue',
    severity: 'error',
    summary: (p) => `Scheduler could not ${str(p, 'action', 'act')} on engine ${str(p, 'engineId')}`,
    facts: ['engineId', 'action'],
  },

  // --- Library cleanup ------------------------------------------------------
  [DOMAIN_EVENTS.LIBRARY_CLEANUP_SEEDING_UNVERIFIED]: {
    permission: PERMISSIONS.LIBRARY_CLEANUP_VIEW,
    category: 'library_cleanup',
    severity: 'warning',
    summary: (p) =>
      `Purge skipped ${str(p, 'skipped', 'items')} — seeding could not be verified`,
    facts: ['skipped', 'policyName'],
  },

  // --- Storage --------------------------------------------------------------
  [DOMAIN_EVENTS.SYSTEM_STORAGE_WARNING]: {
    permission: PERMISSIONS.SYSTEM_VIEW,
    category: 'storage',
    severity: 'warning',
    summary: (p) => `Storage low on ${str(p, 'path', 'a volume')}`,
    facts: ['path', 'percentUsed'],
  },
  [DOMAIN_EVENTS.SYSTEM_STORAGE_CRITICAL]: {
    permission: PERMISSIONS.SYSTEM_VIEW,
    category: 'storage',
    severity: 'critical',
    summary: (p) => `Storage critically low on ${str(p, 'path', 'a volume')}`,
    facts: ['path', 'percentUsed'],
  },
  [DOMAIN_EVENTS.SYSTEM_STORAGE_RECOVERED]: {
    permission: PERMISSIONS.SYSTEM_VIEW,
    category: 'storage',
    severity: 'info',
    summary: (p) => `Storage recovered on ${str(p, 'path', 'a volume')}`,
    facts: ['path', 'percentUsed'],
  },

  // --- Workflows ------------------------------------------------------------
  [DOMAIN_EVENTS.WORKFLOW_APPROVAL_REQUESTED]: {
    permission: PERMISSIONS.WORKFLOWS_VIEW,
    category: 'workflow',
    severity: 'warning',
    summary: (p) => `Workflow "${str(p, 'workflowName', 'a workflow')}" is waiting for approval`,
    facts: ['workflowName'],
  },
  [DOMAIN_EVENTS.WORKFLOW_EXECUTION_FAILED]: {
    permission: PERMISSIONS.WORKFLOWS_VIEW,
    category: 'workflow',
    severity: 'error',
    summary: (p) => `Workflow "${str(p, 'workflowName', 'a workflow')}" failed`,
    facts: ['workflowName'],
  },
  [DOMAIN_EVENTS.WORKFLOW_EXECUTION_COMPLETED]: {
    permission: PERMISSIONS.WORKFLOWS_VIEW,
    category: 'workflow',
    severity: 'info',
    summary: (p) => `Workflow "${str(p, 'workflowName', 'a workflow')}" completed`,
    facts: ['workflowName'],
  },

  // --- Providers ------------------------------------------------------------
  [DOMAIN_EVENTS.PROVIDER_OFFLINE]: {
    permission: PERMISSIONS.SYSTEM_VIEW,
    category: 'provider',
    severity: 'error',
    summary: (p) => `Provider offline: ${str(p, 'providerName', 'a provider')}`,
    facts: ['providerName', 'providerType'],
  },
  [DOMAIN_EVENTS.PROVIDER_RECOVERED]: {
    permission: PERMISSIONS.SYSTEM_VIEW,
    category: 'provider',
    severity: 'info',
    summary: (p) => `Provider recovered: ${str(p, 'providerName', 'a provider')}`,
    facts: ['providerName', 'providerType'],
  },

  // --- Security -------------------------------------------------------------
  /*
   * Gated on `audit.view` rather than `users.view`. These are the events an
   * account takeover produces, and the person who should see them streaming past
   * is whoever is trusted with the audit log — not everyone who may list users.
   * The username is deliberately absent from a failed login: repeated failures
   * are the signal, and naming the account turns a stream into a list of names
   * worth trying.
   */
  [DOMAIN_EVENTS.SECURITY_LOGIN_FAILED]: {
    permission: PERMISSIONS.AUDIT_VIEW,
    category: 'security',
    severity: 'warning',
    summary: () => 'A login attempt failed',
    facts: [],
  },
  [DOMAIN_EVENTS.SECURITY_PASSWORD_CHANGED]: {
    permission: PERMISSIONS.AUDIT_VIEW,
    category: 'security',
    severity: 'info',
    summary: () => 'A password was changed',
    facts: [],
  },
  [DOMAIN_EVENTS.SECURITY_API_KEY_CREATED]: {
    permission: PERMISSIONS.AUDIT_VIEW,
    category: 'security',
    severity: 'warning',
    summary: (p) => `An API key was created: ${str(p, 'name', 'unnamed')}`,
    facts: ['name'],
  },
  [DOMAIN_EVENTS.SECURITY_TWO_FACTOR_DISABLED]: {
    permission: PERMISSIONS.AUDIT_VIEW,
    category: 'security',
    severity: 'warning',
    summary: () => 'Two-factor authentication was disabled on an account',
    facts: [],
  },

  // --- Users ----------------------------------------------------------------
  [DOMAIN_EVENTS.USER_CREATED]: {
    permission: PERMISSIONS.USERS_VIEW,
    category: 'user',
    severity: 'info',
    summary: (p) => `User created: ${str(p, 'username', 'an account')}`,
    facts: ['username'],
  },
  [DOMAIN_EVENTS.USER_ROLE_CHANGED]: {
    permission: PERMISSIONS.USERS_VIEW,
    category: 'user',
    severity: 'warning',
    summary: (p) => `Role changed for ${str(p, 'username', 'an account')}`,
    facts: ['username', 'role'],
  },
};

/**
 * The mapping for an event key, or null when the key is not published to consoles.
 *
 * `hasOwn` rather than a plain lookup: an event key is a string that ultimately
 * comes from a producer, and `MAPPINGS['toString']` on an object literal returns
 * `Object.prototype.toString` — a truthy value that would be treated as a
 * mapping and read `.permission` off a function, publishing an event scoped to
 * `undefined`. The catalogue makes that unreachable today; this makes it
 * unreachable regardless of what the catalogue does tomorrow.
 */
export function mappingFor(eventKey: string): OperationsEventMapping | null {
  return Object.hasOwn(MAPPINGS, eventKey) ? MAPPINGS[eventKey] : null;
}

/** Every key the console stream can carry. Used by the contract test. */
export function mappedEventKeys(): string[] {
  return Object.keys(MAPPINGS);
}

/** The allowlisted, scalar-only facts for one event. */
export function factsFor(
  mapping: OperationsEventMapping,
  payload: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const key of mapping.facts) {
    const value = scalar(payload[key]);
    if (value !== null) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Platform jobs
// ---------------------------------------------------------------------------

/**
 * Job events, which reach the gateway without passing through the bus.
 *
 * Their permission is not a constant: `PlatformJobService` scopes each job by
 * the job's OWN `requiredPermission`, so the value is read off the emit rather
 * than looked up here. That is the whole reason the bridge observes the gateway
 * instead of re-deriving scoping it would inevitably get wrong.
 */
export interface JobEventLike {
  jobId?: unknown;
  type?: unknown;
  moduleKey?: unknown;
  status?: unknown;
  phase?: unknown;
  progress?: unknown;
  errorCode?: unknown;
  message?: unknown;
  correlationId?: unknown;
  at?: unknown;
}

/** Severity from a job's status. Anything unrecognised is informational. */
export function jobSeverity(status: string): OperationsSeverity {
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'stalled' || status === 'completed_with_warnings') return 'warning';
  return 'info';
}

export function jobSummary(payload: JobEventLike): string {
  const name = scalar(payload.type) ?? 'job';
  const status = scalar(payload.status) ?? 'updated';
  const phase = scalar(payload.phase);
  return phase ? `Job ${name}: ${status} (${phase})` : `Job ${name}: ${status}`;
}
