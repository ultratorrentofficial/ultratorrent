/**
 * The platform domain-event contract.
 *
 * A domain event states **that something happened**, in the vocabulary of the
 * domain, with no opinion about who cares. Producers publish; subscribers decide
 * what to do. That separation is the entire point: notifications, automation and
 * workflow waits are three independent readers of the same fact, and none of them
 * appears in the code that produced it.
 *
 * This is deliberately *not* named after any consumer. The bus this replaces was
 * called `NOTIFICATION_BUS_CHANNEL`, which is why removing notifications also
 * removed automation and workflow triggering — the name had made one subscriber
 * look like the purpose.
 *
 * Lives in `shared` because event keys and payload shapes are a contract between
 * the backend that publishes them and anything that later reads them.
 */

/** The single channel every domain event is published on. */
export const DOMAIN_EVENT_CHANNEL = 'domain.event';

/**
 * Canonical event keys, `namespace.entity_verb`.
 *
 * A key appears here only when something really publishes it. An event that
 * cannot fire is worse than an absent one: it shows up in every catalogue and
 * preference screen, and quietly never arrives.
 */
export const DOMAIN_EVENTS = {
  // --- Playback ------------------------------------------------------------
  MEDIA_SERVER_USER_STARTED_WATCHING: 'media_server.user_started_watching',
  MEDIA_SERVER_USER_STOPPED_WATCHING: 'media_server.user_stopped_watching',
  MEDIA_SERVER_REFRESH_FAILED: 'media_server.refresh_failed',

  // --- Torrents ------------------------------------------------------------
  /*
   * File-level facts, published by whatever moved the bytes.
   *
   * The seam that keeps the database honest without coupling modules: the file
   * manager cannot call into media (media already depends on files, so that
   * would be a cycle), and any future mover gets the bookkeeping for free by
   * publishing rather than by remembering to update five tables.
   */
  FILE_MOVED: 'file.moved',
  FILE_DELETED: 'file.deleted',
  TORRENT_COMPLETED: 'torrent.completed',
  TORRENT_FAILED: 'torrent.failed',

  // --- Torrent Activity Scheduler ------------------------------------------
  // Only four, and each has a real producer. A sweep runs every minute and
  // reconciles the same state each time, so these describe TRANSITIONS —
  // something an operator would want to be told about — rather than the fact
  // that a sweep happened.
  TORRENT_SCHEDULER_MODE_CHANGED: 'torrent_scheduler.mode_changed',
  TORRENT_SCHEDULER_HEALTH_CHANGED: 'torrent_scheduler.health_changed',
  TORRENT_SCHEDULER_SEED_TARGET_REACHED: 'torrent_scheduler.seed_target_reached',
  TORRENT_SCHEDULER_ACTION_FAILED: 'torrent_scheduler.action_failed',

  // --- Storage -------------------------------------------------------------
  SYSTEM_STORAGE_WARNING: 'system.storage_warning',
  SYSTEM_STORAGE_CRITICAL: 'system.storage_critical',
  SYSTEM_STORAGE_RECOVERED: 'system.storage_recovered',

  // --- Workflows -----------------------------------------------------------
  WORKFLOW_APPROVAL_REQUESTED: 'workflow.approval_requested',
  WORKFLOW_EXECUTION_FAILED: 'workflow.execution_failed',
  WORKFLOW_EXECUTION_COMPLETED: 'workflow.execution_completed',

  // --- Providers -----------------------------------------------------------
  PROVIDER_OFFLINE: 'provider.offline',
  PROVIDER_RECOVERED: 'provider.recovered',

  // --- Security ------------------------------------------------------------
  SECURITY_LOGIN_FAILED: 'security.login_failed',
  SECURITY_PASSWORD_CHANGED: 'security.password_changed',
  SECURITY_API_KEY_CREATED: 'security.api_key_created',
  SECURITY_TWO_FACTOR_DISABLED: 'security.two_factor_disabled',

  // --- Users ---------------------------------------------------------------
  USER_CREATED: 'user.created',
  USER_ROLE_CHANGED: 'user.role_changed',
} as const;

export type DomainEventKey = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

/**
 * The envelope every publisher sends.
 *
 * `payload` carries the domain facts. The identity fields beside it are hoisted
 * out of the payload on purpose: a subscriber routing an event to "the affected
 * user" or "the owner of this resource" must not have to know each event's payload
 * shape to find them.
 */
export interface DomainEventEnvelope<TPayload = unknown> {
  /** Unique per occurrence. The idempotency key — a redelivery reuses it. */
  id: string;
  eventKey: DomainEventKey | string;
  /** ISO 8601, set by the publisher. */
  occurredAt: string;
  /** Who caused it, when a local user did. Absent for scheduled/system causes. */
  actorUserId?: string;
  /** Who it is *about*, when that differs from the actor. */
  subjectUserId?: string;
  /** What it concerns — `torrent`, `workflow_execution`, `media_item`, … */
  resourceType?: string;
  resourceId?: string;
  payload: TPayload;
  /** Ties every event produced by one logical operation together. */
  correlationId?: string;
  /** The event that caused this one, for a causal chain. */
  causationId?: string;
}

/**
 * A published event's payload contract.
 *
 * `requiredFields` is intentionally a plain list rather than a schema library:
 * it catches the failure that actually happens — a producer forgetting a field a
 * consumer needs — without adding a dependency or a second type system beside
 * TypeScript.
 */
export interface DomainEventDefinition {
  key: DomainEventKey | string;
  /** Human-readable, for logs and the admin health view. Not user-facing copy. */
  description: string;
  /** Payload keys that must be present and non-null for the event to publish. */
  requiredFields: readonly string[];
  /**
   * Suppress a repeat of the same (key, dedupeKey) inside this window. Producers
   * that poll — a session reconciler, a disk watcher — would otherwise republish
   * the same fact every tick.
   */
  deduplicationWindowSeconds?: number;
}

/** Build an envelope's dedupe identity. Same fact ⇒ same string. */
export function domainEventDedupeKey(
  eventKey: string,
  resourceType?: string,
  resourceId?: string,
): string {
  return [eventKey, resourceType ?? '', resourceId ?? ''].join(':');
}

/**
 * Validate an envelope against its definition.
 *
 * Returns the list of problems rather than throwing: publishing is best-effort
 * and must never break the operation that produced the event, so the caller logs
 * and drops instead of failing upward.
 */
export function validateDomainEvent(
  envelope: DomainEventEnvelope,
  definition: DomainEventDefinition | undefined,
): string[] {
  const problems: string[] = [];
  if (!envelope.id) problems.push('missing id');
  if (!envelope.eventKey) problems.push('missing eventKey');
  if (!envelope.occurredAt || Number.isNaN(Date.parse(envelope.occurredAt))) {
    problems.push('occurredAt is not an ISO timestamp');
  }
  if (!definition) {
    problems.push(`unregistered event "${envelope.eventKey}"`);
    return problems;
  }
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  for (const field of definition.requiredFields) {
    if (payload[field] === undefined || payload[field] === null) {
      problems.push(`payload.${field} is required`);
    }
  }
  return problems;
}
