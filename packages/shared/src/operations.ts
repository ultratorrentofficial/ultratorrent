/**
 * The operations contract — the read-only aggregate surface UltraTorrent
 * Console consumes.
 *
 * This file is a **contract**, not a second model. Every field here is a
 * projection of state some existing service already owns; nothing in the
 * operations module measures, polls, or persists anything of its own.
 *
 * Two rules govern what may appear below:
 *
 * 1. **No secrets, ever.** Not an api key, a passkey, a token, a webhook url, a
 *    tracker announce url, a viewer's IP, or a provider-internal path. The
 *    backend must not put them on the wire — a client-side redaction step is
 *    not a boundary, it is a hope.
 * 2. **Bounded.** Every list carries a cap. A snapshot is an operational
 *    reading, not an export; a console that asks for one every few seconds must
 *    not be able to ask the database for a library scan.
 */

/**
 * The operations contract version, `major.minor.patch`.
 *
 * A client compares its own expectation against this and decides: same major →
 * compatible; newer minor → compatible, some fields may be unknown; different
 * major → incompatible, say so plainly rather than rendering nonsense.
 */
export const OPERATIONS_CONTRACT_VERSION = '1.1.0';

/** Every domain the snapshot can carry. */
export const OPERATIONS_DOMAINS = [
  'system',
  'storage',
  'torrents',
  'queue',
  'mediaIntake',
  'media',
  'playback',
  'jobs',
  'automation',
  'acquisition',
  'engines',
  'indexers',
  'providers',
  'notifications',
  'recentActivity',
  'alerts',
] as const;

export type OperationsDomainKey = (typeof OPERATIONS_DOMAINS)[number];

/**
 * Why a domain is not in the snapshot.
 *
 * `forbidden` is deliberately distinguishable from `unavailable`: a console
 * showing "you may not see this" and one showing "this is broken" send an
 * operator to two different places, and collapsing them wastes the trip.
 */
export type OperationsDomainUnavailableReason =
  | 'forbidden'
  | 'unavailable'
  | 'disabled'
  | 'timeout';

export type OperationsDomain<T> =
  | { available: true; data: T }
  | {
      available: false;
      reason: OperationsDomainUnavailableReason;
      /** Safe to display. Never a stack trace, never a connection string. */
      message?: string;
    };

/** Health as an operator reads it, never as a colour alone. */
export type OperationsHealth = 'healthy' | 'degraded' | 'down' | 'unknown';

export type OperationsSeverity = 'info' | 'warning' | 'error' | 'critical';

// ---------------------------------------------------------------------------
// Domain payloads
// ---------------------------------------------------------------------------

export interface OperationsSystem {
  product: string;
  version: string;
  apiVersion: string;
  gitSha: string | null;
  gitTag: string | null;
  buildTime: string | null;
  nodeVersion: string;
  /** Seconds the backend process has been up. */
  uptimeSeconds: number;
  /** Resident set size, bytes. */
  memoryBytes: number;
  /** 1/5/15-minute load average, as the host reports it. */
  loadAverage: [number, number, number];
  cpuCount: number;
  database: OperationsHealth;
  /**
   * Redis is optional in this platform (caching/coordination only), so
   * `unknown` here means "not reported", not "broken".
   */
  cache: OperationsHealth;
}

export interface OperationsStorageRoot {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  /** 0-100, or null when the root could not be measured. */
  usedPercent: number | null;
  health: OperationsHealth;
  error?: string;
}

export interface OperationsStorage {
  roots: OperationsStorageRoot[];
}

/** One torrent, as the operations view needs it. A projection of the engine's normalized shape. */
export interface OperationsTorrent {
  hash: string;
  name: string;
  engineId: string;
  state: string;
  /** 0..1. */
  progress: number;
  sizeBytes: number;
  downloadRate: number;
  uploadRate: number;
  ratio: number;
  /** Seconds, or null when not downloading / unknown. */
  eta: number | null;
  seedsConnected: number;
  peersConnected: number;
  addedAt: string | null;
  completedAt: string | null;
  /** Engine-reported message — a stall or error reason. Never a tracker url. */
  message: string | null;
  /** True when the platform, not a person, is holding this out of the queue. */
  parked: boolean;
  /** Why the platform parked it, when it did. */
  parkedReason: string | null;
  /** The intake job claiming this hash, when one does. */
  intakeState: string | null;
  /** Downloading but moving no bytes with no peers — an operator's "stalled". */
  stalled: boolean;
}

export interface OperationsTorrents {
  counts: {
    total: number;
    downloading: number;
    seeding: number;
    paused: number;
    queued: number;
    checking: number;
    errored: number;
    stalled: number;
    parked: number;
  };
  rates: {
    downloadRate: number;
    uploadRate: number;
    /** Lifetime, from the transfer ledger — not a sum of surviving torrents. */
    totalDownloaded: number;
    totalUploaded: number;
    ratio: number;
  };
  /** Bounded. The full list is `GET /api/torrents`. */
  active: OperationsTorrent[];
  /** Bounded. Errored and stalled first — what an operator opens the console for. */
  attention: OperationsTorrent[];
  /** True when `active`/`attention` were truncated by the cap. */
  truncated: boolean;
  /**
   * When this picture was taken, which is NOT when the snapshot was built.
   *
   * Torrents are read from what the engine poller last saw — normally under two
   * seconds old — because a console must not make every engine answer a second
   * time on its account. That makes staleness a real property of the data, so it
   * travels with it: a client showing rates as "now" when the poller stopped
   * five minutes ago is stating something false. Null when no engine has been
   * polled yet this boot, which is the honest answer rather than a zeroed list.
   */
  observedAt: string | null;
}

export interface OperationsQueueEntry {
  hash: string;
  name: string;
  engineId: string;
  currentState: string;
  desiredState: string | null;
  /** The scheduler's own words for why this is waiting. */
  reason: string | null;
  policyName: string | null;
  priority: number | null;
  /** Set when a person overrode the scheduler for this torrent. */
  override: string | null;
  protectedFromRemoval: boolean;
}

export interface OperationsQueue {
  /** Per engine: `native` (engine's own queue) | `observe` | `managed`. */
  engineModes: Array<{ engineId: string; mode: string; health: OperationsHealth }>;
  entries: OperationsQueueEntry[];
  truncated: boolean;
}

export interface OperationsIntakeJob {
  id: string;
  state: string;
  torrentHash: string | null;
  engineId: string | null;
  /** Basename only — a staging path is infrastructure detail, not an identity. */
  sourceName: string;
  strategy: string | null;
  attempts: number;
  lastError: string | null;
  libraryId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  importedAt: string | null;
}

export interface OperationsMediaIntake {
  byState: Record<string, number>;
  active: number;
  failed: number;
  quarantined: number;
  importedToday: number;
  recent: OperationsIntakeJob[];
  truncated: boolean;
}

export interface OperationsMedia {
  totalItems: number;
  byType: Record<string, number>;
  unmatched: number;
  lowConfidence: number;
  missingArtwork: number;
  missingSubtitles: number;
  duplicateGroups: number;
  failedJobs: number;
  recentlyAdded: number;
  libraries: Array<{
    id: string;
    name: string;
    kind: string;
    enabled: boolean;
    itemCount: number | null;
    lastScanAt: string | null;
    /** Null means manual scans only, which is a configuration, not a fault. */
    scanIntervalMinutes: number | null;
  }>;
}

export interface OperationsPlaybackSession {
  id: string;
  /** The viewer as a person would write it. Never an IP, never a provider token. */
  viewer: string | null;
  title: string;
  showTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  year: number | null;
  mediaType: string | null;
  libraryName: string | null;
  device: string | null;
  client: string | null;
  playbackState: string | null;
  progressPercent: number | null;
  /** direct play | direct stream | transcode, as the provider reports it. */
  playbackMethod: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  resolution: string | null;
  container: string | null;
  bitrateKbps: number | null;
  startedAt: string;
  updatedAt: string;
}

export interface OperationsPlayback {
  sessions: OperationsPlaybackSession[];
  transcoding: number;
  directPlaying: number;
  truncated: boolean;
}

export interface OperationsJob {
  id: string;
  type: string;
  moduleKey: string;
  status: string;
  phase: string | null;
  progress: number | null;
  message: string | null;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface OperationsJobs {
  byStatus: Record<string, number>;
  running: number;
  queued: number;
  failed: number;
  active: number;
  completedToday: number;
  failedToday: number;
  /** 0-100, or null when nothing finished today. */
  successRate: number | null;
  recent: OperationsJob[];
  truncated: boolean;
}

export interface OperationsAutomationRun {
  id: string;
  ruleId: string;
  ruleName: string;
  status: string;
  message: string | null;
  /** The trigger that fired it, when the log records one. */
  trigger: string | null;
  at: string;
}

export interface OperationsAutomation {
  rules: Array<{
    id: string;
    name: string;
    enabled: boolean;
    trigger: string | null;
    lastRunAt: string | null;
    lastStatus: string | null;
  }>;
  recentRuns: OperationsAutomationRun[];
  failures24h: number;
  truncated: boolean;
}

export interface OperationsAcquisitionEvent {
  id: string;
  feedId: string | null;
  feedName: string | null;
  /**
   * The rule that judged this item, when one did.
   *
   * `RssHistory` is keyed per feed item and holds no rule, so this is resolved
   * from the rule's own match evaluation. An item no rule ever evaluated —
   * every feed carries far more items than any rule wants — legitimately has
   * none, and null says so rather than inventing an attribution.
   */
  ruleId: string | null;
  ruleName: string | null;
  releaseTitle: string;
  /**
   * `downloaded` | `skipped_duplicate` | `matched` | `no_match`.
   *
   * Derived from what the platform actually records: `RssHistory.downloaded`
   * and `.matched`, refined by the evaluation's own verdict. `matched` means a
   * rule wanted it and it was not taken — the state worth an operator's
   * attention, and the one a plain "rejected" would hide.
   */
  result: string;
  /** The evaluation's verdict when it explains a non-download. */
  reason: string | null;
  torrentHash: string | null;
  at: string;
}

export interface OperationsAcquisition {
  feeds: Array<{
    id: string;
    name: string;
    enabled: boolean;
    /**
     * Set only after a poll that SUCCEEDED, which is what makes it a health
     * signal: a feed whose fetch is failing keeps an ageing timestamp.
     */
    lastPolledAt: string | null;
    /**
     * How often this feed is meant to be polled. Carried so a console can say
     * "overdue" from `lastPolledAt` instead of guessing a threshold.
     *
     * There is deliberately no `lastError` here: RSS poll failures are logged
     * and never persisted, so the field could only ever be null. A column that
     * is structurally always empty reads as "no feed has ever failed", which is
     * worse than not offering it — staleness against this interval is the
     * honest signal the platform can actually support.
     */
    refreshIntervalSeconds: number;
    ruleCount: number;
  }>;
  recent: OperationsAcquisitionEvent[];
  grabs24h: number;
  truncated: boolean;
}

export interface OperationsEngine {
  engineId: string;
  kind: string;
  health: OperationsHealth;
  /** Null when the engine has never been reached since boot. */
  lastSeenAt: string | null;
  error: string | null;
  version: string | null;
  torrentCount: number | null;
}

export interface OperationsIndexer {
  id: string;
  name: string;
  implementation: string;
  protocol: string;
  enabled: boolean;
  priority: number;
  health: OperationsHealth;
  message: string | null;
  lastTestedAt: string | null;
}

/**
 * A non-engine external service: metadata, artwork, subtitle, media-server and
 * companion integrations, flattened into one shape so the console renders one
 * table instead of six.
 */
export interface OperationsProvider {
  /** metadata | artwork | subtitle | media_server | companion */
  category: string;
  key: string;
  name: string;
  enabled: boolean;
  health: OperationsHealth;
  message: string | null;
  version: string | null;
  lastCheckedAt: string | null;
  /** A short capability summary — never configuration, never credentials. */
  capabilities: string[];
}

export interface OperationsNotifications {
  /** Delivery counts in the last 24 hours, by status. */
  last24h: Record<string, number>;
  pending: number;
  failed24h: number;
  recent: Array<{
    id: string;
    eventKey: string;
    channelType: string;
    status: string;
    attempts: number;
    /** Present only for the caller's own deliveries, or with `users.view`. */
    recipient: string | null;
    error: string | null;
    at: string;
  }>;
  truncated: boolean;
}

export interface OperationsActivityItem {
  id: string;
  type: string;
  /**
   * The rendered line, actor included.
   *
   * There is no separate `actor` field because the source does not keep one:
   * `DashboardService.recentActivity()` composes the person into the message
   * (`"… · Ana Rivera"`) and the audit row's user does not survive the collapse
   * step. Splitting it back out here would mean re-deriving from audit — a
   * second implementation of a feed this module exists to reuse.
   */
  message: string;
  /** The specifics under the line — a rename's `from → to`, a failure's error. */
  detail: string | null;
  level: 'info' | 'success' | 'warning' | 'error';
  /** How many events this line stands for; 1 when it is a single event. */
  eventCount: number;
  at: string;
}

/**
 * An attention item.
 *
 * **Alerts are a projection, not an entity.** They are computed from health,
 * job, intake, storage and provider state each time a snapshot is built. They
 * have no persistent identity, cannot be acknowledged, and do not survive a
 * restart — the condition does, and the alert reappears because of it. The `id`
 * is stable for the same condition so a console can avoid re-announcing it, and
 * means nothing to the server.
 */
export interface OperationsAlert {
  id: string;
  severity: OperationsSeverity;
  /** The domain it came from, so a console can route the operator there. */
  domain: OperationsDomainKey;
  title: string;
  detail: string | null;
  /** When the underlying condition was first observable, when that is known. */
  since: string | null;
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

export interface OperationsSnapshot {
  contractVersion: string;
  generatedAt: string;
  /** How long the backend took to build this, ms. An operator's cost signal. */
  durationMs: number;
  domains: {
    system?: OperationsDomain<OperationsSystem>;
    storage?: OperationsDomain<OperationsStorage>;
    torrents?: OperationsDomain<OperationsTorrents>;
    queue?: OperationsDomain<OperationsQueue>;
    mediaIntake?: OperationsDomain<OperationsMediaIntake>;
    media?: OperationsDomain<OperationsMedia>;
    playback?: OperationsDomain<OperationsPlayback>;
    jobs?: OperationsDomain<OperationsJobs>;
    automation?: OperationsDomain<OperationsAutomation>;
    acquisition?: OperationsDomain<OperationsAcquisition>;
    engines?: OperationsDomain<OperationsEngine[]>;
    indexers?: OperationsDomain<OperationsIndexer[]>;
    providers?: OperationsDomain<OperationsProvider[]>;
    notifications?: OperationsDomain<OperationsNotifications>;
    recentActivity?: OperationsDomain<OperationsActivityItem[]>;
    alerts?: OperationsDomain<OperationsAlert[]>;
  };
}

// ---------------------------------------------------------------------------
// Capability handshake
// ---------------------------------------------------------------------------

/**
 * What a console learns before it renders anything.
 *
 * The point of `permittedDomains` is that a console hides what it cannot fetch
 * rather than rendering thirteen permission errors. It is a convenience for the
 * client, never the authorization: the snapshot re-checks every domain itself.
 */
export interface OperationsCapabilities {
  contractVersion: string;
  server: {
    product: string;
    version: string;
    apiVersion: string;
    gitSha: string | null;
    gitTag: string | null;
    buildTime: string | null;
  };
  /** Domains this backend can serve at all (a disabled module drops out). */
  availableDomains: OperationsDomainKey[];
  /** Domains the calling identity is permitted to read. */
  permittedDomains: OperationsDomainKey[];
  user: {
    id: string;
    username: string;
    roles: string[];
    /** Only the view-shaped grants the console cares about. */
    permissions: string[];
  };
  /** The live event channel a console subscribes to after the snapshot. */
  eventChannel: string;
  /** Server-side caps, so a client does not have to guess. */
  limits: {
    maxItemsPerDomain: number;
    /** Minimum seconds between full snapshots the server wants to serve. */
    minSnapshotIntervalSeconds: number;
  };
}

// ---------------------------------------------------------------------------
// The unified operational event
// ---------------------------------------------------------------------------

/** The single realtime channel the console's event stream subscribes to. */
export const OPERATIONS_EVENT_CHANNEL = 'operations.event';

/**
 * One line of the operational narrative.
 *
 * Deliberately flat and small. This crosses the wire many times a second on a
 * busy install, and a console keeps a bounded ring buffer of them — an envelope
 * carrying an arbitrary payload would make both the wire and the buffer
 * unbounded, and would be the obvious way for a secret to escape.
 */
export interface OperationsEvent {
  /** Unique per occurrence; a redelivery reuses it, so a client can dedupe. */
  id: string;
  /** ISO 8601, from the server. The console never invents a timestamp. */
  at: string;
  /** The domain-event key, or the platform channel name for job events. */
  eventKey: string;
  /** Coarse grouping for filtering: torrent, media_intake, job, … */
  category: string;
  severity: OperationsSeverity;
  /** One line, already localised to a neutral operational register. */
  summary: string;
  /** What it concerns — `torrent`, `media_item`, `platform_job`, … */
  resourceType: string | null;
  resourceId: string | null;
  /** The person who caused it, by display name. Never an id-only leak. */
  actor: string | null;
  /** Ties every event from one logical operation together. */
  correlationId: string | null;
  /**
   * A small, explicitly-allowlisted set of scalar facts for filtering and
   * display — engine id, job type, library name. Never a raw payload.
   */
  facts: Record<string, string | number | boolean>;
}
