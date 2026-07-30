/**
 * Media Intake — the shared contract.
 *
 * The engine is a state machine over one downloaded thing, and this file is the
 * machine: the states, the legal transitions, the placement strategies and the
 * capabilities that decide between them. It is deliberately pure and has no
 * imports, so both the backend pipeline and the dashboard reason from the same
 * definition rather than each keeping its own copy of "what can follow what".
 *
 * Nothing here knows about a filesystem, a torrent client or a media server.
 * Provider-specific behaviour lives behind the interfaces the backend defines
 * on top of these types.
 */

// --- lifecycle -------------------------------------------------------------

/**
 * Where one intake sits in its life.
 *
 * The happy path is a straight line from `queued` to `archived`. The three
 * exits — `failed`, `quarantined`, `cancelled` — are states rather than an
 * error field because an operator needs to *find* them: "show me everything
 * quarantined" is a query, not a log search.
 */
export const INTAKE_STATES = [
  'queued',
  'downloading',
  'completed',
  'verified',
  'identified',
  'metadata_ready',
  'artwork_ready',
  'subtitle_ready',
  'quality_scored',
  'ready_to_import',
  'importing',
  'imported',
  'seeding',
  'archived',
  'failed',
  'quarantined',
  'cancelled',
] as const;

export type IntakeState = (typeof INTAKE_STATES)[number];

/**
 * States the pipeline will never leave on its own.
 *
 * `imported` is deliberately NOT terminal: the torrent goes on seeding
 * afterwards, and that is a state the operator asks about ("what is still
 * seeding from last week"), not an afterthought.
 */
export const TERMINAL_INTAKE_STATES: readonly IntakeState[] = [
  'archived',
  'failed',
  'quarantined',
  'cancelled',
] as const;

/**
 * The legal moves.
 *
 * Every state may fail, and every state may be cancelled by an operator, so
 * those two edges are added programmatically rather than repeated seventeen
 * times below — repetition is where a table like this rots.
 *
 * `quarantined` is reachable only from the checks that can *detect* a reason to
 * quarantine (verification and identification). Quarantine means "a human must
 * look at this", and a stage that cannot form that opinion must not claim it.
 */
const HAPPY_PATH: Record<IntakeState, readonly IntakeState[]> = {
  queued: ['downloading', 'completed'],
  downloading: ['completed'],
  // Verification can conclude the payload is not what it claimed to be.
  completed: ['verified', 'quarantined'],
  verified: ['identified', 'quarantined'],
  identified: ['metadata_ready'],
  metadata_ready: ['artwork_ready'],
  artwork_ready: ['subtitle_ready'],
  subtitle_ready: ['quality_scored'],
  quality_scored: ['ready_to_import'],
  ready_to_import: ['importing'],
  importing: ['imported'],
  imported: ['seeding', 'archived'],
  seeding: ['archived'],
  archived: [],
  // A retry re-enters the pipeline at the point that failed; the engine records
  // which state that was, so the edge back is "any non-terminal state".
  failed: [...INTAKE_STATES.filter((s) => !TERMINAL_INTAKE_STATES.includes(s))],
  // Releasing a quarantine resumes the run; it never jumps straight to import.
  quarantined: ['verified', 'identified', 'failed'],
  cancelled: [],
};

/** Whether the engine may move an intake from `from` to `to`. */
export function canTransition(from: IntakeState, to: IntakeState): boolean {
  if (from === to) return false;
  if (TERMINAL_INTAKE_STATES.includes(from) && from !== 'failed' && from !== 'quarantined') {
    return false;
  }
  if (to === 'failed' || to === 'cancelled') return !TERMINAL_INTAKE_STATES.includes(from);
  return HAPPY_PATH[from].includes(to);
}

/** The state a stage advances to on success, or null at the end of the line. */
export function nextState(from: IntakeState): IntakeState | null {
  return HAPPY_PATH[from][0] ?? null;
}

/** Is this intake still moving? Drives the dashboard's "active" filter. */
export function isActiveIntake(state: IntakeState): boolean {
  return !TERMINAL_INTAKE_STATES.includes(state) && state !== 'seeding';
}

// --- import strategies -----------------------------------------------------

/**
 * How a file gets from staging into a library.
 *
 * Ordered by preference, cheapest and most reversible first. `auto` is not a
 * strategy but an instruction to pick one from detected capabilities — kept in
 * the same union so a profile or a rule can store "decide for me" without a
 * second nullable column meaning the same thing.
 */
export const IMPORT_STRATEGIES = [
  'auto',
  'hardlink',
  'reflink',
  'provider_relocation',
  'copy',
  'move',
] as const;

export type ImportStrategy = (typeof IMPORT_STRATEGIES)[number];

/** Strategies that leave the original in place, so seeding survives the import. */
export const SEEDING_SAFE_STRATEGIES: readonly ImportStrategy[] = [
  'hardlink',
  'reflink',
  'provider_relocation',
  'copy',
] as const;

/**
 * Does the source survive this strategy?
 *
 * `move` is the only one that does not, which is why it is last in preference
 * and why a rule that still needs to seed must never resolve to it.
 */
export function preservesSource(strategy: ImportStrategy): boolean {
  return strategy !== 'move';
}

// --- storage capabilities --------------------------------------------------

/**
 * What a pair of locations can actually do.
 *
 * Detected, never assumed. A hardlink needs one filesystem; a reflink needs one
 * filesystem that also supports copy-on-write (btrfs, XFS, APFS, ZFS); a
 * provider relocation needs a torrent client that can be told to move its own
 * data. Guessing any of these from a path string is how an import silently
 * becomes a full copy on a NAS.
 */
export interface StorageCapabilities {
  /** Same device, so `link()` can work. */
  sameDevice: boolean;
  hardlink: boolean;
  reflink: boolean;
  symlink: boolean;
  /** The torrent provider holding this data can relocate it itself. */
  providerRelocation: boolean;
  /** Filesystem type when it could be determined — diagnostic, never a gate. */
  filesystem?: string | null;
}

/**
 * Choose a strategy from what the storage can do.
 *
 * Preference order is hardlink → reflink → provider relocation → copy, and
 * `move` is never auto-selected: it destroys the source, and an engine that
 * silently stops a torrent seeding because a filesystem lacked a feature would
 * be doing something the operator never asked for. An explicit `move` is
 * honoured; an inferred one is not.
 *
 * `requireSeeding` narrows the same list rather than switching on a different
 * one — one preference order, one place to change it.
 */
export function selectStrategy(
  caps: StorageCapabilities,
  opts: { override?: ImportStrategy; requireSeeding?: boolean } = {},
): { strategy: ImportStrategy; reason: string } {
  const { override, requireSeeding = true } = opts;

  if (override && override !== 'auto') {
    // An administrator override is honoured even when detection disagrees:
    // detection can be wrong about an exotic mount, and the override exists
    // precisely for that. It is still reported, so the audit says it was forced.
    return { strategy: override, reason: 'administrator override' };
  }

  const ordered: ImportStrategy[] = ['hardlink', 'reflink', 'provider_relocation', 'copy'];
  for (const candidate of ordered) {
    if (requireSeeding && !SEEDING_SAFE_STRATEGIES.includes(candidate)) continue;
    if (candidate === 'hardlink' && caps.hardlink && caps.sameDevice) {
      return { strategy: 'hardlink', reason: 'same device, hardlinks supported' };
    }
    if (candidate === 'reflink' && caps.reflink && caps.sameDevice) {
      return { strategy: 'reflink', reason: 'copy-on-write filesystem' };
    }
    if (candidate === 'provider_relocation' && caps.providerRelocation) {
      return { strategy: 'provider_relocation', reason: 'the download client can relocate its own data' };
    }
    if (candidate === 'copy') {
      return { strategy: 'copy', reason: 'no link or relocation available' };
    }
  }
  return { strategy: 'copy', reason: 'fallback' };
}

// --- path mapping ----------------------------------------------------------

/**
 * The spaces a path can be expressed in.
 *
 * The same bytes are `/mnt/plexmedia/x` to the host, `/downloads/x` inside the
 * backend container, and possibly a third thing to the torrent client and a
 * fourth to Plex. Every one of those has been a real bug class; the registry
 * exists so no module ever hard-codes one space's spelling.
 */
export const PATH_SPACES = ['canonical', 'host', 'container', 'provider', 'media_server'] as const;
export type PathSpace = (typeof PATH_SPACES)[number];

/** One prefix rewrite, from the canonical spelling into a given space. */
export interface PathMappingRule {
  id: string;
  space: PathSpace;
  /** Canonical prefix, e.g. `/media`. */
  fromPrefix: string;
  /** How that prefix is spelled in `space`, e.g. `/mnt/plexmedia`. */
  toPrefix: string;
  /** Narrow to one engine or media server; null applies to every one of that space. */
  scopeId?: string | null;
  /** Higher wins when several rules match; ties break on the longer prefix. */
  priority: number;
  enabled: boolean;
}

/** Normalise for prefix comparison: no trailing separator, no doubled ones. */
function normalizePrefix(p: string): string {
  const collapsed = p.replace(/\/+/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
}

/**
 * Does `path` sit under `prefix`?
 *
 * Compared segment-wise, because a plain `startsWith` makes `/media-backup` a
 * child of `/media` — which would rewrite a path into an unrelated tree.
 */
export function isUnderPrefix(path: string, prefix: string): boolean {
  const p = normalizePrefix(path);
  const q = normalizePrefix(prefix);
  return p === q || p.startsWith(q === '/' ? '/' : `${q}/`);
}

/**
 * Translate a canonical path into one space.
 *
 * Returns the input unchanged when no rule matches: an unmapped path is a path
 * that means the same thing everywhere, which is the common case on a
 * single-host install and must not require configuration.
 */
export function toSpace(
  canonical: string,
  space: PathSpace,
  rules: readonly PathMappingRule[],
  scopeId?: string | null,
): string {
  if (space === 'canonical') return canonical;
  const match = rules
    .filter((r) => r.enabled && r.space === space)
    .filter((r) => r.scopeId == null || r.scopeId === scopeId)
    .filter((r) => isUnderPrefix(canonical, r.fromPrefix))
    // Most specific first: an explicit scope beats a global rule, then higher
    // priority, then the longer prefix — so `/media/tv` wins over `/media`.
    .sort(
      (a, b) =>
        Number(b.scopeId != null) - Number(a.scopeId != null) ||
        b.priority - a.priority ||
        normalizePrefix(b.fromPrefix).length - normalizePrefix(a.fromPrefix).length,
    )[0];
  if (!match) return canonical;
  const from = normalizePrefix(match.fromPrefix);
  const to = normalizePrefix(match.toPrefix);
  const rest = normalizePrefix(canonical).slice(from.length);
  return `${to}${rest}` || '/';
}

/** Translate a path expressed in `space` back to canonical. */
export function fromSpace(
  path: string,
  space: PathSpace,
  rules: readonly PathMappingRule[],
  scopeId?: string | null,
): string {
  if (space === 'canonical') return path;
  const inverted = rules
    .filter((r) => r.enabled && r.space === space)
    .map((r) => ({ ...r, fromPrefix: r.toPrefix, toPrefix: r.fromPrefix }));
  return toSpace(path, space, inverted.map((r) => ({ ...r, space })), scopeId);
}

// --- RSS integration -------------------------------------------------------

/**
 * How a matched release reaches the library.
 *
 * `legacy_direct` is what every existing rule does today and keeps doing: the
 * download client writes into the library tree and the scanner picks it up.
 * `managed_intake` routes through staging and this engine. The value is stored
 * per rule and **never changed automatically** — an upgrade that silently moved
 * a working rule onto a new pipeline is the one outcome this whole design is
 * built to avoid.
 */
export const RSS_IMPORT_MODES = ['legacy_direct', 'managed_intake'] as const;
export type RssImportMode = (typeof RSS_IMPORT_MODES)[number];

/** What a rule created before this feature existed must behave as. */
export const LEGACY_RSS_IMPORT_MODE: RssImportMode = 'legacy_direct';
/** What a rule created from now on gets, absent an explicit choice. */
export const DEFAULT_RSS_IMPORT_MODE: RssImportMode = 'managed_intake';
