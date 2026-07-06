/**
 * Typed fetch client for the UltraTorrent REST API.
 *
 * Responsibilities:
 *  - Persist the access/refresh token pair in localStorage.
 *  - Attach the bearer access token to every request.
 *  - Transparently refresh the access token on a 401 and replay the request
 *    exactly once. Concurrent 401s share a single in-flight refresh.
 *  - Surface a typed `ApiError` and broadcast auth changes so React contexts can
 *    react to forced logout (refresh failure).
 */

import type {
  AuthUser,
  BrowseResponse,
  BulkOperationType,
  CleanupCategory,
  CleanupExecuteResult,
  CleanupPreview,
  FileNode,
  FilePropertiesResponse,
  LicenseStatus,
  LoginResponse,
  ModuleStatus,
  NormalizedFile,
  NormalizedPeer,
  NormalizedTorrent,
  NormalizedTracker,
  Paginated,
  TorrentMatchedRule,
  TrashItemDto,
} from '@ultratorrent/shared';

export type { FileNode, FilePropertiesResponse, CleanupPreview, CleanupCategory, CleanupExecuteResult, TrashItemDto, BrowseResponse, BulkOperationType };

const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:4000/api').replace(/\/$/, '');

const STORAGE_KEY = 'ultratorrent.auth';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms at which the access token expires (best-effort). */
  expiresAt: number;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ---------------------------------------------------------------------------
// Token store + auth-change broadcast
// ---------------------------------------------------------------------------

type AuthListener = (tokens: StoredTokens | null) => void;
const authListeners = new Set<AuthListener>();

let tokens: StoredTokens | null = readTokens();

function readTokens(): StoredTokens | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredTokens;
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getTokens(): StoredTokens | null {
  return tokens;
}

export function getAccessToken(): string | null {
  return tokens?.accessToken ?? null;
}

export function setTokens(next: StoredTokens | null): void {
  tokens = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable — keep in-memory only */
  }
  for (const listener of authListeners) listener(next);
}

export function onAuthChange(listener: AuthListener): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function storeLoginResponse(res: LoginResponse): void {
  setTokens({
    accessToken: res.accessToken,
    refreshToken: res.refreshToken,
    expiresAt: Date.now() + res.expiresIn * 1000,
  });
}

// ---------------------------------------------------------------------------
// Core request pipeline
// ---------------------------------------------------------------------------

type QueryParams = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skip attaching the bearer token (used by login/refresh). */
  auth?: boolean;
  /** Internal: prevent infinite refresh recursion. */
  _retry?: boolean;
  /** Raw body passthrough (e.g. FormData) — skips JSON serialization. */
  raw?: boolean;
  query?: QueryParams;
}

let refreshInFlight: Promise<boolean> | null = null;

async function performRefresh(): Promise<boolean> {
  if (!tokens?.refreshToken) return false;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens?.refreshToken }),
      });
      if (!res.ok) {
        setTokens(null);
        return false;
      }
      const data = (await res.json()) as LoginResponse;
      storeLoginResponse(data);
      return true;
    } catch {
      setTokens(null);
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

function buildUrl(path: string, query?: QueryParams): string {
  // API_URL may be absolute (http://host/api) or relative (/api). Resolving
  // against the current origin makes new URL() valid in both cases.
  const target = path.startsWith('http') ? path : `${API_URL}${path}`;
  const base =
    typeof window !== 'undefined' ? window.location.origin : undefined;
  const url = new URL(target, base);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, auth = true, _retry = false, raw = false, query, headers, ...rest } = options;

  const finalHeaders = new Headers(headers);
  if (auth && tokens?.accessToken) {
    finalHeaders.set('Authorization', `Bearer ${tokens.accessToken}`);
  }

  let finalBody: BodyInit | undefined;
  if (body !== undefined) {
    if (raw || body instanceof FormData) {
      finalBody = body as BodyInit;
    } else {
      finalHeaders.set('Content-Type', 'application/json');
      finalBody = JSON.stringify(body);
    }
  }

  const res = await fetch(buildUrl(path, query), {
    ...rest,
    headers: finalHeaders,
    body: finalBody,
  });

  if (res.status === 401 && auth && !_retry && tokens?.refreshToken) {
    const refreshed = await performRefresh();
    if (refreshed) {
      return request<T>(path, { ...options, _retry: true });
    }
  }

  if (!res.ok) {
    let parsed: unknown;
    let message = `${res.status} ${res.statusText}`;
    try {
      parsed = await res.json();
      const maybe = parsed as { message?: string | string[]; error?: string };
      if (Array.isArray(maybe.message)) message = maybe.message.join(', ');
      else if (typeof maybe.message === 'string') message = maybe.message;
      else if (typeof maybe.error === 'string') message = maybe.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, parsed);
  }

  if (res.status === 204) return undefined as T;
  const contentType = res.headers.get('Content-Type') ?? '';
  if (!contentType.includes('application/json')) {
    return (await res.text()) as unknown as T;
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Domain response shapes (server contracts not in @ultratorrent/shared)
// ---------------------------------------------------------------------------

export interface DashboardSummary {
  engineOnline: boolean;
  downloadRate: number;
  uploadRate: number;
  totalTorrents: number;
  downloading: number;
  paused: number;
  completed: number;
  seeding: number;
  errored: number;
  ratio: number;
  totalUploaded: number;
  totalDownloaded: number;
}

export interface ActivityItem {
  id: string;
  type: string;
  message: string;
  hash?: string | null;
  level?: 'info' | 'success' | 'warning' | 'error';
  at: string;
}

export interface AuditEntry {
  id: string;
  userId: string | null;
  action: string;
  objectType: string | null;
  objectId: string | null;
  result: 'success' | 'failure';
  ipAddress: string | null;
  userAgent: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  user?: { username: string } | null;
}

export interface RssRule {
  id: string;
  /** The feed the rule was created under (its "home" feed). */
  feedId: string;
  /**
   * Every feed this rule targets: its owner feed plus any feed named by an
   * enabled match candidate's feed scope. The rule is polled against — and
   * listed under — each of these.
   */
  feedIds: string[];
  name: string;
  includeRegex: string | null;
  excludeRegex: string | null;
  categoryId: string | null;
  savePath: string | null;
  autoDownload: boolean;
  isEnabled: boolean;
  createdAt: string;
}

export interface RssFeed {
  id: string;
  name: string;
  url: string;
  refreshInterval: number; // seconds
  isEnabled: boolean;
  lastFetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
  rules: RssRule[];
}

export interface RssHistoryItem {
  id: string;
  feedId: string;
  itemGuid: string;
  title: string;
  link: string;
  magnet: string | null;
  matched: boolean;
  downloaded: boolean;
  createdAt: string;
}

/** Portable bundle of rules + match candidates (keyed to feeds by URL). */
export interface RssExportBundle {
  kind: 'ultratorrent.rss-export';
  version: number;
  exportedAt: string;
  rules: unknown[];
}

/** Result of importing an {@link RssExportBundle}. */
export type RssImportMode = 'skip' | 'overwrite' | 'merge';

export interface RssImportSummary {
  mode: RssImportMode;
  feedsCreated: number;
  rulesCreated: number;
  rulesOverwritten: number;
  rulesMerged: number;
  rulesSkipped: number;
  candidatesCreated: number;
  candidatesSkipped: number;
}

/** A page of feed history plus whole-feed status counts (mutually exclusive). */
export interface RssHistoryPage {
  items: RssHistoryItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: { downloaded: number; matched: number; seen: number };
}

export interface CreateFeedInput {
  name: string;
  url: string;
  refreshInterval?: number;
  isEnabled?: boolean;
}

export type UpdateFeedInput = Partial<CreateFeedInput>;

export interface CreateRuleInput {
  feedId: string;
  name: string;
  includeRegex?: string;
  excludeRegex?: string;
  savePath?: string;
  autoDownload?: boolean;
}

/** Editable fields of an RSS rule (feed is fixed). Empty string clears a pattern. */
export type UpdateRuleInput = Partial<Omit<CreateRuleInput, 'feedId'>>;

export interface AutomationCondition {
  field: string;
  op: string;
  value: string | number | boolean;
}

export interface AutomationAction {
  type: string;
  params?: Record<string, unknown>;
}

export interface AutomationRule {
  id: string;
  name: string;
  description: string | null;
  trigger: string;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  isEnabled: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertAutomationInput {
  name: string;
  description?: string;
  trigger: string;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  isEnabled?: boolean;
  priority?: number;
}

export interface AutomationLog {
  id: string;
  ruleId: string;
  status: 'success' | 'failed' | 'skipped';
  context: Record<string, unknown>;
  message: string | null;
  createdAt: string;
}

export interface AccountProfile {
  id: string;
  username: string;
  email: string;
  displayName: string | null;
  roles: string[];
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface TwoFactorSetup {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

// FileNode / BrowseResponse are sourced from @ultratorrent/shared (re-exported above).

export interface SystemHealth {
  status: 'ok' | 'degraded' | 'down';
  uptimeSeconds: number;
  version: string;
  engines: { id: string; kind: string; online: boolean; latencyMs: number | null }[];
  disk: { path: string; freeBytes: number; totalBytes: number }[];
  memory: { usedBytes: number; totalBytes: number } | null;
}

/** File-browser Default Root Path state, from `GET /api/files/root`. */
export interface FileBrowserRoot {
  /** Effective absolute root the browser is confined to. */
  root: string;
  /** Admin-configured value (null = using the env default). */
  configured: string | null;
  /** Ops-controlled hard boundary (FILE_MANAGER_ROOTS). */
  hardRoots: string[];
  exists: boolean;
  readable: boolean;
  writable: boolean;
}

/** Containment + on-disk state for a path, from `GET /api/files/inspect`. */
export interface PathInspection {
  /** The resolved absolute path. */
  path: string;
  /** Inside FILE_MANAGER_ROOTS (the ops hard boundary). */
  withinHardRoots: boolean;
  /** A protected system directory that may never be targeted. */
  isSystemDir: boolean;
  exists: boolean;
  isDirectory: boolean;
  writable: boolean;
}

/** Platform identity + version, from the public `GET /api/system/version`. */
export interface SystemVersion {
  product: string;
  version: string;
  edition: string;
  apiVersion: string;
  gitTag: string | null;
  gitSha: string | null;
  buildTime: string | null;
  node: string;
}

/** Update-availability status from `GET /api/system/update`. */
export interface SystemUpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  deployment: 'docker' | 'bare';
  checkEnabled: boolean;
  checkedAt: string | null;
  error: string | null;
  latestUrl: string | null;
  changelogUrl: string | null;
  /** Deployment-specific commands to apply the update (never auto-applied). */
  updateSteps: string[];
}

export interface ModuleHealth {
  id: string;
  status: 'healthy' | 'disabled' | 'locked' | 'degraded';
  enabled: boolean;
  licensed: boolean;
  unmetDependencies: string[];
  checkedAt: string;
}

export interface AppSettings {
  [key: string]: unknown;
}

export type BulkAction = 'start' | 'stop' | 'pause' | 'resume' | 'recheck' | 'remove' | 'removeData';
export type TorrentAction = 'start' | 'stop' | 'pause' | 'resume' | 'recheck';

export interface TorrentQuery {
  search?: string;
  state?: string;
  category?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface AddTorrentPayload {
  magnet?: string;
  url?: string;
  category?: string;
  tags?: string[];
  savePath?: string;
  startPaused?: boolean;
}

// ---------------------------------------------------------------------------
// Match Preferences (RSS automation candidates)
// ---------------------------------------------------------------------------

export type MatchType =
  | 'exact_text'
  | 'contains_text'
  | 'regex'
  | 'wildcard'
  | 'smart_episode_match'
  | 'smart_movie_match'
  | 'fuzzy_match';

export interface CandidateQualityRules {
  quality?: string;
  source?: string;
  codec?: string;
  resolution?: string;
  season?: number;
  episode?: number;
  year?: number;
}

export interface CandidateSizeRules {
  minBytes?: number;
  maxBytes?: number;
}

export interface CandidateFeedScope {
  feedIds?: string[];
}

export interface RssRuleMatchCandidate {
  id: string;
  rssRuleId: string;
  priorityOrder: number;
  name: string;
  description: string | null;
  enabled: boolean;
  matchType: MatchType;
  pattern: string | null;
  requiredTerms: string[];
  excludedTerms: string[];
  qualityRules: CandidateQualityRules;
  sizeRules: CandidateSizeRules;
  feedScope: CandidateFeedScope;
  lastMatchedAt: string | null;
  matchCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CheckResult {
  label: string;
  passed: boolean;
  detail: string;
}

export interface CandidateResult {
  candidateId: string;
  name: string;
  priorityOrder: number;
  matchType: MatchType;
  result: 'matched' | 'failed' | 'skipped' | 'disabled';
  reason: string;
  checks: CheckResult[];
}

export interface ParsedRelease {
  resolution?: string;
  source?: string;
  codec?: string;
  season?: number;
  episode?: number;
  year?: number;
  languages: string[];
  repack: boolean;
  proper: boolean;
  badQuality: string[];
}

export interface RssRuleMatchEvaluation {
  id: string;
  rssRuleId: string;
  rssItemId: string;
  matchedCandidateId: string | null;
  matchedCandidatePriority: number | null;
  result: 'matched' | 'no_match' | 'skipped_duplicate';
  evaluationTrace: { parsed: ParsedRelease; candidates: CandidateResult[] };
  actionTaken: string | null;
  torrentHash: string | null;
  createdAt: string;
}

/** Body shared by create (all required-ish) and update (partial) candidate calls. */
export interface CandidateInput {
  name: string;
  matchType: MatchType;
  pattern?: string;
  description?: string;
  enabled?: boolean;
  requiredTerms?: string[];
  excludedTerms?: string[];
  qualityRules?: CandidateQualityRules;
  sizeRules?: CandidateSizeRules;
  feedScope?: CandidateFeedScope;
  priorityOrder?: number;
}

export interface ParseExplanation {
  field: string;
  value: string;
  reason: string;
}

export interface ParsedTorrentMeta {
  title: string | null;
  season: number | null;
  episode: number | null;
  absoluteEpisode: number | null;
  part: number | null;
  airDate: string | null;
  year: number | null;
  resolution: string | null;
  source: string | null;
  codec: string | null;
  audio: string[];
  hdr: string[];
  languages: string[];
  releaseGroup: string | null;
  proper: boolean;
  repack: boolean;
  contentType: 'tv_episode' | 'anime_episode' | 'movie' | 'daily' | 'unknown';
  explanations: ParseExplanation[];
  warnings: string[];
  confidence: number;
}

export interface GeneratedCandidate {
  name: string;
  description: string;
  matchType: MatchType;
  pattern: string;
  requiredTerms: string[];
  excludedTerms: string[];
  qualityRules: CandidateQualityRules;
  confidence: 'high' | 'medium' | 'low';
}

export interface SmartAnalyzeResult {
  sourceName: string;
  parsedMetadata: ParsedTorrentMeta;
  confidenceScore: number;
  recommendedCandidates: GeneratedCandidate[];
  explanations: ParseExplanation[];
  warnings: string[];
}

export interface SmartTestResult {
  parsedMetadata: ParsedTorrentMeta;
  candidates: GeneratedCandidate[];
  results: Array<{ title: string } & PreferenceListResultItem>;
  recommendation: {
    matchedCandidateId: string | null;
    matchedCandidateName: string | null;
    action: 'download' | 'none';
  };
}

export interface ApplySmartMatchInput {
  sourceName: string;
  parsedMetadata: ParsedTorrentMeta;
  confidenceScore: number;
  recommendedCandidates: GeneratedCandidate[];
  userEdited: boolean;
}

export interface TestMatchResultItem extends CandidateResult {
  title: string;
}

export interface PreferenceListResultItem {
  title: string;
  matched: boolean;
  matchedCandidateId: string | null;
  matchedCandidatePriority: number | null;
  action: 'download' | 'none';
  candidates: CandidateResult[];
  parsed: ParsedRelease;
}

/** One history item evaluated by `testAgainstHistory` — actionable (grabbable). */
export interface HistoryTestResultItem extends PreferenceListResultItem {
  historyId: string;
  downloaded: boolean;
  hasMagnet: boolean;
}

/** Result of testing a rule's preference list against its stored feed history. */
export interface HistoryTestResult {
  results: HistoryTestResultItem[];
  /** How many history items were available to test against (0 = none yet). */
  historyCount: number;
}

/** Outcome of grabbing already-seen history items that match a rule. */
export interface RssBackfillSummary {
  evaluated: number;
  matched: number;
  downloaded: number;
}

// ---------------------------------------------------------------------------
// Users & roles
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  username: string;
  email: string;
  displayName: string | null;
  isActive: boolean;
  isSystem: boolean;
  lastLoginAt: string | null;
  roles: string[];
}

export interface Role {
  id: string;
  name: string;
  description: string | null;
  permissions: { permission: { key: string } }[];
}

export interface CreateUserInput {
  username: string;
  email: string;
  displayName?: string;
  password: string;
  roleNames: string[];
}

export interface UpdateUserInput {
  email?: string;
  displayName?: string;
  isActive?: boolean;
  roleNames?: string[];
}

// ---------------------------------------------------------------------------
// Media renamer
// ---------------------------------------------------------------------------

export type MediaKind = 'tv' | 'anime' | 'movie' | 'music' | 'audiobook' | 'general';
export type Preset = 'plex' | 'jellyfin' | 'emby' | 'kodi' | 'custom';
export type RenameMode =
  | 'preview'
  | 'rename_in_place'
  | 'rename_move'
  | 'copy'
  | 'hardlink'
  | 'symlink';

export type MediaPresets = Record<
  Exclude<Preset, 'custom'>,
  Partial<Record<MediaKind, string>>
>;

export interface MediaLibrary {
  id: string;
  name: string;
  kind: MediaKind;
  path: string;
  preset: Preset;
  template: string | null;
  mode: RenameMode;
  isEnabled: boolean;
  scanIntervalMinutes: number | null;
  lastScanAt: string | null;
  nfoEnabled: boolean;
  artworkEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLibraryInput {
  name: string;
  path: string;
  kind: MediaKind;
  preset: Preset;
  template?: string;
  mode: RenameMode;
  isEnabled?: boolean;
  scanIntervalMinutes?: number | null;
  nfoEnabled?: boolean;
  artworkEnabled?: boolean;
}

// --- Media Manager (core module `media_manager`) — /api/media ---------------

export type MediaItemType =
  | 'movie'
  | 'tv'
  | 'anime'
  | 'music_video'
  | 'documentary'
  | 'other_video';

export type MediaMatchStatus = 'unmatched' | 'matched' | 'manual';

export interface MediaItem {
  id: string;
  libraryId: string;
  mediaType: MediaItemType;
  title: string;
  sortTitle: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
  matchStatus: MediaMatchStatus;
  confidence: number;
  path: string;
  createdAt: string;
  // Display relations eagerly loaded by the list endpoint (artwork is narrowed
  // to the poster). Optional so the bare-item shape stays valid elsewhere.
  files?: MediaFile[];
  metadata?: MediaMetadata | null;
  artwork?: MediaArtwork[];
  externalIds?: MediaExternalId[];
}

export interface MediaItemQuery {
  mediaType?: string;
  matchStatus?: string;
  libraryId?: string;
}

export interface MediaItemUpdateInput {
  title?: string;
  sortTitle?: string | null;
  mediaType?: MediaItemType;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
}

/** Manual-identification body for `matchItem`; an empty body re-runs auto-match. */
export interface MediaManualMatchInput {
  mediaType?: MediaItemType;
  title?: string;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
}

/** Optional narrowing for a bulk re-identify pass (`reidentifyItems`). */
export interface MediaReidentifyInput {
  /** Restrict to one library (omit to span every library). */
  libraryId?: string;
  /** Restrict to a match state, e.g. `'unmatched'` to retry only failures. */
  matchStatus?: string;
}

/** Outcome tallies from a bulk re-identify pass. */
export interface MediaReidentifySummary {
  total: number;
  matched: number;
  unmatched: number;
  failed: number;
}

export interface MediaHealth {
  total: number;
  byMediaType: Record<string, number>;
  unmatched: number;
  lowConfidence: number;
  missingArtwork: number;
  missingSubtitles: number;
  recentlyAdded: number;
  duplicateGroups: number;
  failedJobs: number;
}

export interface MediaDashboardLibrary {
  id: string;
  name: string;
  kind: MediaKind;
  path: string;
  isEnabled: boolean;
  lastScanAt: string | null;
  itemCount: number;
}

export interface MediaDashboard {
  health: MediaHealth;
  libraries: MediaDashboardLibrary[];
}

export interface MediaScanResult {
  scanned: number;
  added: number;
  updated: number;
  /** On-disk sidecar artwork files imported during the scan. */
  artworkImported: number;
  /** Items whose local .nfo metadata was imported during the scan. */
  metadataImported: number;
}

export interface RenamePlanItem {
  source: string;
  destination: string | null;
  action: string;
  kind: string;
  reason: string;
  skipped: boolean;
  isSubtitle: boolean;
  isSample: boolean;
  isExtra: boolean;
}

export interface RenamePlan {
  mode: RenameMode;
  preset: Preset;
  libraryPath: string;
  kind: MediaKind;
  parsed: Record<string, unknown>;
  items: RenamePlanItem[];
  warnings: string[];
}

export interface RenameRequest {
  hash?: string;
  engineId?: string;
  path?: string;
  preset: Preset;
  mode: RenameMode;
  libraryPath: string;
  template?: string;
}

export interface RenameApplyResult {
  applied: number;
  skipped: number;
  failed: number;
  plan: RenamePlan;
}

export interface MediaRenameOperation {
  id: string;
  source: string;
  destination: string;
  action: string;
  kind: string;
  mode: RenameMode;
  status: string;
  message: string | null;
  torrentHash: string | null;
  createdAt: string;
}

// --- Media Manager detail resources ---------------------------------------

/** A scanned physical file backing a MediaItem. `size` is a BigInt string. */
export interface MediaFile {
  id: string;
  itemId: string;
  path: string;
  size: string;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  resolution: string | null;
  hdr: string | null;
  language: string | null;
  releaseGroup: string | null;
  quality: string | null;
  createdAt: string;
}

export type MediaArtworkType =
  | 'poster'
  | 'fanart'
  | 'logo'
  | 'clearart'
  | 'banner'
  | 'thumbnail'
  | 'season_poster'
  | 'episode_thumbnail';

export interface MediaArtwork {
  id: string;
  itemId: string;
  type: string;
  url: string | null;
  localPath: string | null;
  source: string | null;
  selected: boolean;
  width: number | null;
  height: number | null;
  seasonNumber: number | null;
  createdAt: string;
}

export interface MediaSubtitle {
  id: string;
  itemId: string;
  path: string;
  language: string;
  forced: boolean;
  sdh: boolean;
  source: string | null;
  createdAt: string;
}

export interface MediaMetadata {
  id: string;
  itemId: string;
  title: string | null;
  originalTitle: string | null;
  sortTitle: string | null;
  overview: string | null;
  releaseDate: string | null;
  year: number | null;
  runtime: number | null;
  genres: string[];
  studios: string[];
  cast: Array<{ name: string; role?: string }>;
  crew: Array<{ name: string; job?: string }>;
  directors: string[];
  writers: string[];
  rating: number | null;
  certification: string | null;
  tags: string[];
  providerName: string | null;
  updatedAt: string;
}

export interface MediaExternalId {
  id: string;
  itemId: string;
  provider: string;
  externalId: string;
  url: string | null;
}

export interface MediaNfoFile {
  id: string;
  itemId: string;
  type: string;
  path: string;
  generatedAt: string;
}

/** Full item detail returned by `getItem` (includes relations). */
export interface MediaItemDetail extends MediaItem {
  updatedAt: string;
  duplicateGroupId: string | null;
  files: MediaFile[];
  metadata: MediaMetadata | null;
  artwork: MediaArtwork[];
  subtitles: MediaSubtitle[];
  externalIds: MediaExternalId[];
  nfoFiles: MediaNfoFile[];
  library: MediaLibrary | null;
}

export interface MediaArtworkList {
  itemId: string;
  artwork: MediaArtwork[];
  selected: Record<string, string>;
}

export interface MediaArtworkMissing {
  itemId: string;
  present: string[];
  missing: string[];
}

/**
 * Result of a provider artwork import. When a provider ran, `provider`/`imported`
 * are set; when none was configured it falls back to the missing-art report
 * (`present`/`missing`).
 */
export interface MediaArtworkImportResult {
  itemId: string;
  provider?: string;
  imported?: string[];
  present?: string[];
  missing?: string[];
}

export interface MediaSubtitleMissing {
  itemId: string;
  present: string[];
  missing: string[];
  hasAny: boolean;
}

export interface MediaArtworkUploadInput {
  type: string;
  filename?: string;
  mime?: string;
  /** base64 (optionally a data: URL) payload of the image. */
  dataBase64: string;
  seasonNumber?: number | null;
}

export interface MediaMetadataUpdateInput {
  title?: string;
  originalTitle?: string;
  sortTitle?: string;
  overview?: string;
  year?: number | null;
  runtime?: number | null;
  genres?: string[];
  studios?: string[];
  directors?: string[];
  writers?: string[];
  rating?: number | null;
  certification?: string | null;
  tags?: string[];
}

export interface MediaNfoGenerateResult {
  generated: number;
  files: MediaNfoFile[];
}

/** One item within a detected duplicate group (already quality-scored). */
export interface MediaDuplicateItem {
  id: string;
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  libraryId: string;
  path: string;
  qualityScore: number;
  totalSize: number;
  bestResolution: string | null;
  bestCodec: string | null;
}

export interface MediaDuplicateGroup {
  id: string;
  reason: string;
  createdAt: string;
  suggestedKeepId: string | null;
  items: MediaDuplicateItem[];
}

export type MediaServerKind = 'plex' | 'jellyfin' | 'emby' | 'kodi';

export interface MediaServerIntegration {
  id: string;
  name: string;
  kind: string;
  isEnabled: boolean;
  lastRefreshAt: string | null;
  createdAt: string;
  updatedAt: string;
  config: Record<string, unknown>;
}

export interface MediaServerIntegrationInput {
  name?: string;
  kind?: string;
  isEnabled?: boolean;
  config?: Record<string, unknown>;
}

export interface MediaServerTestResult {
  ok: boolean;
  message?: string;
  [key: string]: unknown;
}

export interface MediaServerRefreshResult {
  id: string;
  lastRefreshAt: string | null;
}

// --- IMDb metadata provider — /api/media/providers/imdb --------------------

export type ImdbMode = 'disabled' | 'dataset' | 'official_api' | 'hybrid';

/** IMDb title kinds accepted by the search endpoint. */
export type ImdbTitleKind = 'movie' | 'tv' | 'episode' | 'any';

export interface ImdbProviderCapabilities {
  source: ImdbMode;
  available: boolean;
  methods: Record<string, boolean>;
}

/** GET providers/imdb/status. */
export interface ImdbStatus {
  source: ImdbMode;
  available: boolean;
  datasetTitleCount: number;
  apiConfigured?: boolean;
  detail?: string;
  capabilities: ImdbProviderCapabilities;
  lastImport: {
    id: string;
    status: string;
    recordsImported: number;
    completedAt: string | null;
    datasetDate: string | null;
  } | null;
}

/** Which IMDb datasets an import pulls in. */
export type ImdbImportStrategy = 'optimized_movies' | 'full';

/** GET/PATCH providers/imdb/settings (secret redacted on read). */
export interface ImdbSettings {
  mode: ImdbMode;
  apiBaseUrl: string | null;
  /** Redacted placeholder ("••••••••") or null on read; write-only otherwise. */
  apiKey: string | null;
  datasetPath: string | null;
  importSchedule: string | null;
  /** When true, a scheduled job downloads + imports the datasets automatically. */
  autoDownloadEnabled: boolean;
  /** Base URL the dataset files are fetched from (defaults to official IMDb). */
  datasetBaseUrl: string;
  /** How often the auto-update job runs, in hours (minimum 1). */
  autoUpdateIntervalHours: number;
  /** Import strategy: the lean optimized movie subset (default) or the full mirror. */
  importStrategy: ImdbImportStrategy;
  /** Optimized import: only titles with startYear >= this are imported. */
  minImportYear: number;
  /** Optimized import: also import TV series/mini-series/episodes, not just movies. */
  importTvShows: boolean;
  /** Optimized import: also import alternate titles (title.akas). */
  importAkas: boolean;
  /** Optimized import: also import crew (title.crew). */
  importCrew: boolean;
  /** Optimized import: also import people (name.basics) — large. */
  importPeople: boolean;
  preferredRegion: string | null;
  preferredLanguage: string | null;
  includeAdult: boolean;
  minVotes: number;
  cacheTtl: number;
  hasApiKey: boolean;
}

export interface ImdbSettingsInput {
  mode?: ImdbMode;
  apiBaseUrl?: string | null;
  /** Omit or send the redacted placeholder to keep the stored key. */
  apiKey?: string | null;
  datasetPath?: string | null;
  importSchedule?: string | null;
  autoDownloadEnabled?: boolean;
  datasetBaseUrl?: string | null;
  autoUpdateIntervalHours?: number;
  importStrategy?: ImdbImportStrategy;
  minImportYear?: number;
  importTvShows?: boolean;
  importAkas?: boolean;
  importCrew?: boolean;
  importPeople?: boolean;
  preferredRegion?: string | null;
  preferredLanguage?: string | null;
  includeAdult?: boolean;
  minVotes?: number;
  cacheTtl?: number;
}

/** Optimized-import scan/skip counters persisted on an import record. */
export interface ImdbImportStats {
  rowsScanned: number;
  rowsImported: number;
  skippedTitleType: number;
  skippedAdult: number;
  skippedMinYear: number;
  skippedParentMissing: number;
  errors: number;
  durationMs: number;
  datasets: string[];
}

export interface ImdbApiTestResult {
  apiConfigured: boolean;
  available: boolean;
}

export interface ImdbDatasetFileReport {
  file: string;
  key: string;
  present: boolean;
  gzipOk: boolean;
  headerOk: boolean;
  sizeBytes: number | null;
  error?: string;
}

export interface ImdbDatasetValidationReport {
  datasetPath: string;
  valid: boolean;
  filesFound: number;
  files: ImdbDatasetFileReport[];
  hasMinimum: boolean;
}

/** A dataset import record (GET dataset/imports, POST dataset/import). */
export interface ImdbDatasetImport {
  id: string;
  status: string; // pending | validating | running | completed | failed | cancelled
  sourcePath: string;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  errorMessage: string | null;
  filesImported: string[];
  recordsImported: number;
  /** Optimized-import counters (null for legacy/full imports). */
  stats?: ImdbImportStats | null;
  /** Strategy that produced this record (optimized_movies | full | null). */
  strategy?: string | null;
  datasetDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImdbSearchInput {
  title: string;
  year?: number;
  type?: ImdbTitleKind;
  season?: number;
  episode?: number;
}

/** A single scored IMDb search hit (GET search). */
export interface ImdbSearchResult {
  tconst: string;
  titleType: string;
  primaryTitle: string;
  originalTitle: string;
  year: number | null;
  isAdult: boolean;
  genres: string[];
  rating: number | null;
  numVotes: number | null;
  /** 0..1 confidence this hit matches the query. */
  confidence: number;
}

/** GET title/:imdbId — full IMDb title details plus a public link. */
export interface ImdbTitle {
  title?: string;
  originalTitle?: string | null;
  overview?: string;
  year?: number;
  runtime?: number;
  genres?: string[];
  directors?: string[];
  writers?: string[];
  cast?: Array<{ name: string; role?: string }>;
  rating?: number;
  providerName?: string;
  externalIds?: Record<string, string>;
  imdbUrl: string;
}

/** POST items/:id/match/imdb body. */
export interface ImdbMatchInput {
  imdbId: string;
  confidence?: number;
}

/** POST items/:id/match/imdb response. */
export interface ImdbMatchResult {
  item: MediaItem;
  imdbId: string;
  rating: number | null;
  matched: boolean;
}

// ---------------------------------------------------------------------------
// Media Renamer Pro (Milestone 6) — /api/media-renamer
// ---------------------------------------------------------------------------

export interface MediaRenamerFileInput {
  path: string;
  size?: number;
}

export interface MediaRenamerAnalyzeResult {
  mediaType: string;
  parsed: Record<string, unknown>;
  confidence: number;
}

export interface MediaRenamerPlanItem {
  source: string;
  destination: string | null;
  action: string;
  kind: string;
  reason: string;
  skipped: boolean;
  isSubtitle: boolean;
  isSample: boolean;
  isExtra: boolean;
}

export interface MediaRenamerPlan {
  kind: string;
  warnings: string[];
  items: MediaRenamerPlanItem[];
}

export interface MediaRenameJob {
  id: string;
  status: string;
  mode: RenameMode;
  sourcePath: string;
  mediaType: string;
  confidenceScore: number;
  createdAt: string;
  completedAt: string | null;
}

export interface MediaRenameJobFile {
  id?: string;
  originalPath: string;
  proposedPath: string;
  finalPath: string | null;
  fileType: string;
  action: string;
  status: string;
  errorMessage: string | null;
}

export interface MediaRenameJobDetail extends MediaRenameJob {
  files: MediaRenameJobFile[];
}

export interface MediaRenamerRunBody {
  sourceName: string;
  files: MediaRenamerFileInput[];
  preset: Preset;
  mode: RenameMode;
  libraryPath: string;
  template?: string;
}

export interface MediaRenamerDryRunResult {
  job: MediaRenameJob;
  plan: MediaRenamerPlan;
}

export interface MediaRenamerRollbackResult {
  ok: boolean;
  reverted: number;
}

export interface MediaRenamerTemplate {
  id: string;
  name: string;
  mediaType: string;
  serverPreset: string;
  template: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpsertMediaRenamerTemplateInput {
  name: string;
  mediaType: string;
  serverPreset: string;
  template: string;
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Release Scoring (Milestone 6) — /api/release-scoring
// ---------------------------------------------------------------------------

export type TrackerHealth = 'healthy' | 'degraded' | 'dead';
export type ReleaseDecision = 'download' | 'review' | 'skip' | 'reject';

export interface ReleaseScoreInput {
  title: string;
  preferredResolution?: string;
  preferredCodec?: string;
  preferredSources?: string[];
  preferredGroups?: string[];
  avoidedGroups?: string[];
  excludedTerms?: string[];
  seeders?: number;
  trackerHealth?: TrackerHealth;
  duplicateRisk?: boolean;
}

export interface ReleaseScoreResult {
  score: number;
  decision: ReleaseDecision;
  reasons: string[];
  warnings: string[];
  parsed: Record<string, unknown>;
}

export interface ReleaseRuleInput extends Omit<ReleaseScoreInput, 'title'> {
  minScore?: number;
}

export interface ReleaseTestRuleInput {
  title: string;
  rule: ReleaseRuleInput;
}

export interface ReleaseTestRuleResult extends ReleaseScoreResult {
  minScore: number;
  passed: boolean;
}

// ---------------------------------------------------------------------------
// Media Acquisition Intelligence — /api/media-acquisition
// ---------------------------------------------------------------------------

export type MediaAcquisitionDecision =
  | 'download'
  | 'skip'
  | 'hold_for_approval'
  | 'upgrade_existing'
  | 'replace_existing'
  | 'manual_review';

export type WatchlistItemType =
  | 'series'
  | 'season'
  | 'episode'
  | 'movie'
  | 'movie_collection'
  | 'anime'
  | 'manual_query';

export type WatchlistStatus = 'active' | 'paused' | (string & {});

export interface MediaAcquisitionRecentDecision {
  id: string;
  releaseName: string;
  decision: MediaAcquisitionDecision;
  reason: string;
  createdAt: string;
}

export interface MediaAcquisitionOverview {
  watchlist: { active: number };
  approvals: { pending: number; approved: number; rejected: number };
  decisions: { recommended: number; skipped: number; upgrades: number; waiting: number };
  missing: { episodes: number; movies: number };
  recent: MediaAcquisitionRecentDecision[];
}

export interface WatchlistItem {
  id: string;
  type: WatchlistItemType;
  title: string;
  year: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  status: WatchlistStatus;
  priority: number;
  profileId: string | null;
  externalIds?: Record<string, string> | null;
  createdAt: string;
}

export interface CreateWatchlistInput {
  type: WatchlistItemType;
  title: string;
  year?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  collectionName?: string;
  status?: WatchlistStatus;
  priority?: number;
  profileId?: string;
  externalIds?: Record<string, string>;
}

export interface UpdateWatchlistInput {
  title?: string;
  year?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  collectionName?: string;
  status?: WatchlistStatus;
  priority?: number;
  profileId?: string | null;
  externalIds?: Record<string, string>;
}

// --- missing episodes -------------------------------------------------------
export type WantedEpisodeStatus = 'missing' | 'unaired' | 'owned' | 'ignored';

export interface SeriesGapSummary {
  watchlistItemId: string;
  title: string;
  seriesTconst: string | null;
  monitorable: boolean;
  total: number;
  owned: number;
  missing: number;
  unaired: number;
  ignored: number;
  lastCheckedAt: string | null;
}

export interface WantedEpisode {
  id: string;
  watchlistItemId: string;
  seriesTconst: string;
  episodeTconst: string | null;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string | null;
  airYear: number | null;
  status: WantedEpisodeStatus;
  lastCheckedAt: string;
}

/** scanSeries returns a single-series gap; scanAll returns an aggregate. */
export interface MissingEpisodesScanResult {
  watchlistItemId?: string;
  title?: string;
  seriesTconst?: string;
  total?: number;
  owned?: number;
  missing: number;
  unaired?: number;
  ignored?: number;
  series?: number;
}

export type AcquisitionMediaType = 'tv' | 'movie' | 'anime' | 'any';

export interface AcquisitionProfile {
  id: string;
  name: string;
  mediaType: AcquisitionMediaType;
  minimumScore: number;
  approvalScore: number;
  preferredResolution: string | null;
  preferredCodec: string | null;
  preferredSource: string | null;
  excludedTerms: string[];
  requiredTerms: string[];
  preferredGroups: string[];
  enabled: boolean;
}

export interface CreateAcquisitionProfileInput {
  name: string;
  mediaType: AcquisitionMediaType;
  minimumScore?: number;
  approvalScore?: number;
  minimumResolution?: string;
  preferredResolution?: string;
  preferredSource?: string;
  preferredCodec?: string;
  preferredAudio?: string;
  preferredHdr?: string;
  preferredLanguages?: string[];
  requiredTerms?: string[];
  excludedTerms?: string[];
  preferredGroups?: string[];
  duplicateRules?: Record<string, unknown>;
  storageRules?: Record<string, unknown>;
  automationRules?: Record<string, unknown>;
  enabled?: boolean;
}

export type AcquisitionApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'not_required'
  | (string & {});

export interface AcquisitionTraceStep {
  step: string;
  status: string;
  reason: string;
  score?: number;
  decision?: string;
}

export interface AcquisitionEvaluation {
  id: string;
  releaseName: string;
  decision: MediaAcquisitionDecision;
  decisionReason: string;
  confidence: number;
  requiresApproval: boolean;
  approvalStatus: AcquisitionApprovalStatus;
  trace: { steps: AcquisitionTraceStep[] };
  releaseScore: number;
  libraryMatch: unknown;
  duplicateRisk: unknown;
  createdAt?: string;
}

export interface AcquisitionEvaluationAction {
  id?: string;
  actionType?: string;
  status?: string;
  message?: string | null;
  createdAt?: string;
  [key: string]: unknown;
}

export interface AcquisitionEvaluationDetail extends AcquisitionEvaluation {
  actions: AcquisitionEvaluationAction[];
}

export interface EvaluateInput {
  releaseName: string;
  sourceType?: string;
  profileId?: string;
  sizeBytes?: number;
  seeders?: number;
}

export interface SimulationStage {
  key: string;
  label: string;
  status: 'success' | 'warning' | 'blocked' | 'info';
  summary: string;
  detail?: Record<string, unknown>;
}

export interface SimulationResult {
  releaseName: string;
  decision: string;
  reason: string;
  confidence: number;
  requiresApproval: boolean;
  profile: { id: string; name: string } | null;
  stages: SimulationStage[];
  trace: unknown;
}

export interface AcquisitionHistoryEvent {
  eventType: string;
  message: string;
  createdAt: string;
}

export interface AcquisitionRecommendations {
  pendingApprovals: { id: string; releaseName: string; reason: string }[];
  qualityUpgrades: { id: string; releaseName: string }[];
  watchlistWithNoMatches: { id: string; title: string }[];
}

export interface AcquisitionSettings {
  autoEvaluateRss: boolean;
  defaultProfileId: string | null;
  approvalExpiryHours: number;
  notifyOnApprovalRequired: boolean;
}

export interface AcquisitionExportInput {
  evaluations?: boolean;
  watchlist?: boolean;
  profiles?: boolean;
}

// ---------------------------------------------------------------------------
// Public API surface
// ---------------------------------------------------------------------------

// --- Torrent engines (core) ------------------------------------------------
export type EngineKind = 'rtorrent' | 'qbittorrent' | 'transmission' | 'deluge';
export type EngineMode = 'scgi-tcp' | 'scgi-unix' | 'http';

export interface EngineConnectionInput {
  mode: EngineMode;
  host?: string;
  port?: number;
  socketPath?: string;
  url?: string;
  timeoutMs?: number;
}

export interface EngineSummary {
  id: string;
  name: string;
  kind: string;
  isDefault: boolean;
  isEnabled: boolean;
  mode?: EngineMode;
  host?: string;
  port?: number;
  socketPath?: string;
  url?: string;
  timeoutMs?: number;
}

export interface CreateEngineInput {
  name: string;
  kind: string;
  config: EngineConnectionInput;
  isDefault?: boolean;
  isEnabled?: boolean;
}

export interface UpdateEngineInput {
  name?: string;
  config?: EngineConnectionInput;
  isDefault?: boolean;
  isEnabled?: boolean;
}

export interface EngineHealthStatus {
  online: boolean;
  latencyMs: number | null;
  version: string | null;
  error: string | null;
  checkedAt: string;
}

export const api = {
  auth: {
    async login(
      username: string,
      password: string,
      totp?: string,
    ): Promise<LoginResponse> {
      const res = await request<LoginResponse>('/auth/login', {
        method: 'POST',
        auth: false,
        body: { username, password, ...(totp ? { totp } : {}) },
      });
      storeLoginResponse(res);
      return res;
    },
    async logout(): Promise<void> {
      const refreshToken = tokens?.refreshToken;
      try {
        if (refreshToken) {
          await request<void>('/auth/logout', {
            method: 'POST',
            body: { refreshToken },
          });
        }
      } finally {
        setTokens(null);
      }
    },
    me(): Promise<AuthUser> {
      return request<AuthUser>('/auth/me');
    },
  },

  dashboard: {
    summary(): Promise<DashboardSummary> {
      return request<DashboardSummary>('/dashboard/summary');
    },
    activity(): Promise<ActivityItem[]> {
      return request<ActivityItem[]>('/dashboard/activity');
    },
  },

  torrents: {
    list(query: TorrentQuery = {}): Promise<Paginated<NormalizedTorrent>> {
      return request<Paginated<NormalizedTorrent>>('/torrents', {
        query: query as QueryParams,
      });
    },
    get(hash: string): Promise<NormalizedTorrent> {
      return request<NormalizedTorrent>(`/torrents/${hash}`);
    },
    files(hash: string): Promise<NormalizedFile[]> {
      return request<NormalizedFile[]>(`/torrents/${hash}/files`);
    },
    matchedRule(hash: string): Promise<TorrentMatchedRule | null> {
      return request<TorrentMatchedRule | null>(`/torrents/${hash}/matched-rule`);
    },
    peers(hash: string): Promise<NormalizedPeer[]> {
      return request<NormalizedPeer[]>(`/torrents/${hash}/peers`);
    },
    trackers(hash: string): Promise<NormalizedTracker[]> {
      return request<NormalizedTracker[]>(`/torrents/${hash}/trackers`);
    },
    add(payload: AddTorrentPayload): Promise<NormalizedTorrent> {
      return request<NormalizedTorrent>('/torrents', { method: 'POST', body: payload });
    },
    upload(file: File, options: Omit<AddTorrentPayload, 'magnet' | 'url'> = {}): Promise<NormalizedTorrent> {
      const form = new FormData();
      form.append('file', file);
      if (options.category) form.append('category', options.category);
      if (options.savePath) form.append('savePath', options.savePath);
      if (options.startPaused != null) form.append('startPaused', String(options.startPaused));
      if (options.tags?.length) form.append('tags', options.tags.join(','));
      return request<NormalizedTorrent>('/torrents/upload', { method: 'POST', body: form, raw: true });
    },
    action(hash: string, action: TorrentAction): Promise<void> {
      return request<void>(`/torrents/${hash}/${action}`, { method: 'POST' });
    },
    remove(hash: string, withData = false): Promise<void> {
      return request<void>(`/torrents/${hash}${withData ? '/data' : ''}`, { method: 'DELETE' });
    },
    bulk(hashes: string[], action: BulkAction): Promise<void> {
      return request<void>('/torrents/bulk', { method: 'POST', body: { hashes, action } });
    },
  },

  audit: {
    list(query: { page?: number; pageSize?: number } = {}): Promise<Paginated<AuditEntry>> {
      return request<Paginated<AuditEntry>>('/audit', { query });
    },
  },

  rss: {
    list(): Promise<RssFeed[]> {
      return request<RssFeed[]>('/rss/feeds');
    },
    createFeed(body: CreateFeedInput): Promise<RssFeed> {
      return request<RssFeed>('/rss/feeds', { method: 'POST', body });
    },
    updateFeed(id: string, body: UpdateFeedInput): Promise<RssFeed> {
      return request<RssFeed>(`/rss/feeds/${id}`, { method: 'PATCH', body });
    },
    deleteFeed(id: string): Promise<void> {
      return request<void>(`/rss/feeds/${id}`, { method: 'DELETE' });
    },
    history(
      feedId: string,
      query: { page?: number; pageSize?: number } = {},
    ): Promise<RssHistoryPage> {
      return request<RssHistoryPage>(`/rss/feeds/${feedId}/history`, { query });
    },
    refreshFeed(feedId: string): Promise<{ newItems: number; downloaded: number }> {
      return request<{ newItems: number; downloaded: number }>(
        `/rss/feeds/${feedId}/refresh`,
        { method: 'POST' },
      );
    },
    createRule(body: CreateRuleInput): Promise<RssRule> {
      return request<RssRule>('/rss/rules', { method: 'POST', body });
    },
    exportRules(): Promise<RssExportBundle> {
      return request<RssExportBundle>('/rss/rules-export');
    },
    exportFeedRules(feedId: string): Promise<RssExportBundle> {
      return request<RssExportBundle>(`/rss/feeds/${feedId}/rules-export`);
    },
    importRules(bundle: unknown, mode: RssImportMode = 'skip'): Promise<RssImportSummary> {
      return request<RssImportSummary>('/rss/rules-import', {
        method: 'POST',
        body: bundle,
        query: { mode },
      });
    },
    updateRule(id: string, body: UpdateRuleInput): Promise<RssRule> {
      return request<RssRule>(`/rss/rules/${id}`, { method: 'PATCH', body });
    },
    deleteRule(id: string): Promise<void> {
      return request<void>(`/rss/rules/${id}`, { method: 'DELETE' });
    },
    listCandidates(ruleId: string): Promise<RssRuleMatchCandidate[]> {
      return request<RssRuleMatchCandidate[]>(`/rss/rules/${ruleId}/match-candidates`);
    },
    createCandidate(
      ruleId: string,
      body: CandidateInput,
    ): Promise<RssRuleMatchCandidate & { backfill?: RssBackfillSummary }> {
      return request<RssRuleMatchCandidate & { backfill?: RssBackfillSummary }>(
        `/rss/rules/${ruleId}/match-candidates`,
        { method: 'POST', body },
      );
    },
    updateCandidate(
      ruleId: string,
      candidateId: string,
      body: Partial<CandidateInput>,
    ): Promise<RssRuleMatchCandidate & { backfill?: RssBackfillSummary }> {
      return request<RssRuleMatchCandidate & { backfill?: RssBackfillSummary }>(
        `/rss/rules/${ruleId}/match-candidates/${candidateId}`,
        { method: 'PATCH', body },
      );
    },
    deleteCandidate(ruleId: string, candidateId: string): Promise<void> {
      return request<void>(`/rss/rules/${ruleId}/match-candidates/${candidateId}`, {
        method: 'DELETE',
      });
    },
    reorderCandidates(ruleId: string, orderedIds: string[]): Promise<RssRuleMatchCandidate[]> {
      return request<RssRuleMatchCandidate[]>(
        `/rss/rules/${ruleId}/match-candidates/reorder`,
        { method: 'POST', body: { orderedIds } },
      );
    },
    testMatch(
      ruleId: string,
      body: { candidateId?: string; candidate?: CandidateInput; titles: string[] },
    ): Promise<{ results: TestMatchResultItem[] }> {
      return request<{ results: TestMatchResultItem[] }>(
        `/rss/rules/${ruleId}/test-match`,
        { method: 'POST', body },
      );
    },
    testPreferenceList(
      ruleId: string,
      body: { titles: string[] },
    ): Promise<{ results: PreferenceListResultItem[] }> {
      return request<{ results: PreferenceListResultItem[] }>(
        `/rss/rules/${ruleId}/test-preference-list`,
        { method: 'POST', body },
      );
    },
    testAgainstHistory(ruleId: string): Promise<HistoryTestResult> {
      return request<HistoryTestResult>(`/rss/rules/${ruleId}/test-history`, {
        method: 'POST',
      });
    },
    backfill(ruleId: string): Promise<RssBackfillSummary> {
      return request<RssBackfillSummary>(`/rss/rules/${ruleId}/backfill`, {
        method: 'POST',
      });
    },
    downloadHistoryItem(historyId: string): Promise<RssHistoryItem & { torrentHash: string }> {
      return request<RssHistoryItem & { torrentHash: string }>(
        `/rss/history/${historyId}/download`,
        { method: 'POST' },
      );
    },
    matchHistory(ruleId: string): Promise<RssRuleMatchEvaluation[]> {
      return request<RssRuleMatchEvaluation[]>(`/rss/rules/${ruleId}/match-history`);
    },
    convertToRegex(text: string): Promise<{ pattern: string }> {
      return request<{ pattern: string }>('/rss/convert-to-regex', {
        method: 'POST',
        body: { text },
      });
    },
    analyzeSmartMatch(torrentName: string): Promise<SmartAnalyzeResult> {
      return request<SmartAnalyzeResult>('/rss/smart-match/analyze', {
        method: 'POST',
        body: { torrentName },
      });
    },
    testSmartMatch(body: {
      torrentName: string;
      sampleItems?: string[];
      rssFeedId?: string;
    }): Promise<SmartTestResult> {
      return request<SmartTestResult>('/rss/smart-match/test', {
        method: 'POST',
        body,
      });
    },
    applySmartMatch(
      ruleId: string,
      body: ApplySmartMatchInput,
    ): Promise<RssRuleMatchCandidate[]> {
      return request<RssRuleMatchCandidate[]>(`/rss/rules/${ruleId}/apply-smart-match`, {
        method: 'POST',
        body,
      });
    },
  },

  automation: {
    list(): Promise<AutomationRule[]> {
      return request<AutomationRule[]>('/automation/rules');
    },
    create(body: UpsertAutomationInput): Promise<AutomationRule> {
      return request<AutomationRule>('/automation/rules', {
        method: 'POST',
        body,
      });
    },
    update(id: string, body: UpsertAutomationInput): Promise<AutomationRule> {
      return request<AutomationRule>(`/automation/rules/${id}`, {
        method: 'PATCH',
        body,
      });
    },
    remove(id: string): Promise<void> {
      return request<void>(`/automation/rules/${id}`, { method: 'DELETE' });
    },
    logs(id: string): Promise<AutomationLog[]> {
      return request<AutomationLog[]>(`/automation/rules/${id}/logs`);
    },
  },

  files: {
    /** @deprecated use browse(); retained for back-compat. */
    async list(path = '/'): Promise<FileNode[]> {
      const res = await request<BrowseResponse>('/files', { query: { path } });
      return res?.items ?? [];
    },
    browse(path = '/'): Promise<BrowseResponse> {
      return request<BrowseResponse>('/files', { query: { path } });
    },
    /** Effective Default Root Path + read/write status. */
    root(): Promise<FileBrowserRoot> {
      return request<FileBrowserRoot>('/files/root');
    },
    /** Change the Default Root Path (admin; validated + audited server-side). */
    setRoot(path: string): Promise<FileBrowserRoot> {
      return request<FileBrowserRoot>('/files/root', { method: 'PUT', body: { path } });
    },
    properties(path: string): Promise<FilePropertiesResponse> {
      return request<FilePropertiesResponse>('/files/properties', { query: { path } });
    },
    preview(path: string): Promise<{ path: string; content: string }> {
      return request<{ path: string; content: string }>('/files/preview', { query: { path } });
    },
    /** Fetch the file with the bearer token and trigger a browser download. */
    async download(path: string): Promise<void> {
      const token = getAccessToken();
      const res = await fetch(buildUrl('/files/download', { path }), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new ApiError(res.status, `Download failed (${res.status})`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = path.split('/').filter(Boolean).pop() ?? 'download';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    },
    createFolder(path: string, name: string): Promise<unknown> {
      return request('/files/folders', { method: 'POST', body: { path, name } });
    },
    /** Containment + existence of an arbitrary path (for pre-save validation). */
    inspectPath(path: string): Promise<PathInspection> {
      return request<PathInspection>('/files/inspect', { query: { path } });
    },
    /** Create a directory (recursively) inside the hard roots; idempotent. */
    ensureDir(path: string): Promise<PathInspection> {
      return request<PathInspection>('/files/ensure-dir', { method: 'POST', body: { path } });
    },
    rename(path: string, newName: string, overwrite = false): Promise<unknown> {
      return request('/files/rename', { method: 'POST', body: { path, newName, overwrite } });
    },
    move(source: string, destination: string, overwrite = false): Promise<unknown> {
      return request('/files/move', { method: 'POST', body: { source, destination, overwrite } });
    },
    copy(source: string, destination: string, overwrite = false): Promise<unknown> {
      return request('/files/copy', { method: 'POST', body: { source, destination, overwrite } });
    },
    remove(path: string, permanent = false): Promise<unknown> {
      return request('/files/delete', { method: 'POST', body: { path, permanent } });
    },
    bulk(dto: {
      operation: BulkOperationType;
      paths: string[];
      destination?: string;
      overwrite?: boolean;
      permanent?: boolean;
    }): Promise<{ operation: string; total: number; succeeded: number; failed: number; results: Array<{ path: string; ok: boolean; message?: string }> }> {
      return request('/files/bulk', { method: 'POST', body: dto });
    },
    cleanupPreview(path: string, categories?: CleanupCategory[]): Promise<CleanupPreview> {
      return request<CleanupPreview>('/files/cleanup-preview', {
        method: 'POST',
        body: { path, categories },
      });
    },
    cleanupExecute(path: string, paths: string[], permanent = false): Promise<CleanupExecuteResult> {
      return request<CleanupExecuteResult>('/files/cleanup-execute', {
        method: 'POST',
        body: { path, paths, permanent },
      });
    },
    trash: {
      list(): Promise<TrashItemDto[]> {
        return request<TrashItemDto[]>('/files/trash');
      },
      restore(id: string, overwrite = false): Promise<unknown> {
        return request('/files/trash/restore', { method: 'POST', body: { id, overwrite } });
      },
      purge(id: string): Promise<unknown> {
        return request('/files/trash/purge', { method: 'POST', body: { id } });
      },
      empty(): Promise<{ removed: number; bytes: number }> {
        return request('/files/trash/empty', { method: 'POST', body: {} });
      },
    },
  },

  settings: {
    get(): Promise<AppSettings> {
      return request<AppSettings>('/settings');
    },
    update(patch: AppSettings): Promise<AppSettings> {
      return request<AppSettings>('/settings', { method: 'PATCH', body: patch });
    },
  },

  account: {
    profile(): Promise<AccountProfile> {
      return request<AccountProfile>('/account/profile');
    },
    updateProfile(body: {
      email?: string;
      displayName?: string;
    }): Promise<AccountProfile> {
      return request<AccountProfile>('/account/profile', {
        method: 'PATCH',
        body,
      });
    },
    changePassword(
      currentPassword: string,
      newPassword: string,
    ): Promise<{ success: boolean }> {
      return request('/account/password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      });
    },
    twoFactorStatus(): Promise<{ enabled: boolean }> {
      return request('/account/2fa');
    },
    setupTwoFactor(): Promise<TwoFactorSetup> {
      return request<TwoFactorSetup>('/account/2fa/setup', { method: 'POST' });
    },
    enableTwoFactor(code: string): Promise<{ recoveryCodes: string[] }> {
      return request('/account/2fa/enable', { method: 'POST', body: { code } });
    },
    disableTwoFactor(password: string): Promise<{ success: boolean }> {
      return request('/account/2fa/disable', {
        method: 'POST',
        body: { password },
      });
    },
    regenerateRecovery(code: string): Promise<{ recoveryCodes: string[] }> {
      return request('/account/2fa/recovery', {
        method: 'POST',
        body: { code },
      });
    },
  },

  system: {
    health(): Promise<SystemHealth> {
      return request<SystemHealth>('/system/health');
    },
    version(): Promise<SystemVersion> {
      return request<SystemVersion>('/system/version');
    },
    /** Whether a newer release exists + how to apply it for this deployment. */
    update(): Promise<SystemUpdateStatus> {
      return request<SystemUpdateStatus>('/system/update');
    },
    /** Force a fresh update check now. */
    checkUpdate(): Promise<SystemUpdateStatus> {
      return request<SystemUpdateStatus>('/system/update/check', { method: 'POST' });
    },
    /** Enable/disable the background update check (super-admin). */
    setUpdateCheck(enabled: boolean): Promise<SystemUpdateStatus> {
      return request<SystemUpdateStatus>('/system/update/settings', {
        method: 'PATCH',
        body: { enabled },
      });
    },
  },

  modules: {
    list(): Promise<ModuleStatus[]> {
      return request<ModuleStatus[]>('/modules');
    },
    enabled(): Promise<ModuleStatus[]> {
      return request<ModuleStatus[]>('/modules/enabled');
    },
    license(): Promise<LicenseStatus> {
      return request<LicenseStatus>('/modules/license');
    },
    get(id: string): Promise<ModuleStatus> {
      return request<ModuleStatus>(`/modules/${id}`);
    },
    health(id: string): Promise<ModuleHealth> {
      return request<ModuleHealth>(`/modules/${id}/health`);
    },
    enable(id: string): Promise<ModuleStatus> {
      return request<ModuleStatus>(`/modules/${id}/enable`, { method: 'POST' });
    },
    disable(id: string): Promise<ModuleStatus> {
      return request<ModuleStatus>(`/modules/${id}/disable`, { method: 'POST' });
    },
  },

  users: {
    list(): Promise<User[]> {
      return request<User[]>('/users');
    },
    roles(): Promise<Role[]> {
      return request<Role[]>('/users/roles');
    },
    create(body: CreateUserInput): Promise<User> {
      return request<User>('/users', { method: 'POST', body });
    },
    update(id: string, body: UpdateUserInput): Promise<User> {
      return request<User>(`/users/${id}`, { method: 'PATCH', body });
    },
    remove(id: string): Promise<void> {
      return request<void>(`/users/${id}`, { method: 'DELETE' });
    },
  },

  engines: {
    list(): Promise<EngineSummary[]> {
      return request<EngineSummary[]>('/engines');
    },
    create(body: CreateEngineInput): Promise<{ id: string }> {
      return request<{ id: string }>('/engines', { method: 'POST', body });
    },
    update(id: string, body: UpdateEngineInput): Promise<{ id: string }> {
      return request<{ id: string }>(`/engines/${id}`, { method: 'PATCH', body });
    },
    remove(id: string): Promise<void> {
      return request<void>(`/engines/${id}`, { method: 'DELETE' });
    },
    test(body: { kind: string; config: EngineConnectionInput }): Promise<EngineHealthStatus> {
      return request<EngineHealthStatus>('/engines/test', { method: 'POST', body });
    },
    health(engineId?: string): Promise<EngineHealthStatus> {
      return request<EngineHealthStatus>('/engines/health', { query: { engineId } });
    },
  },

  media: {
    presets(): Promise<MediaPresets> {
      return request<MediaPresets>('/media/presets');
    },
    dashboard(): Promise<MediaDashboard> {
      return request<MediaDashboard>('/media/dashboard');
    },
    health(): Promise<MediaHealth> {
      return request<MediaHealth>('/media/health');
    },
    libraries(): Promise<MediaLibrary[]> {
      return request<MediaLibrary[]>('/media/libraries');
    },
    /** Alias of {@link libraries} for the Media Manager surface. */
    listLibraries(): Promise<MediaLibrary[]> {
      return request<MediaLibrary[]>('/media/libraries');
    },
    createLibrary(body: CreateLibraryInput): Promise<MediaLibrary> {
      return request<MediaLibrary>('/media/libraries', { method: 'POST', body });
    },
    updateLibrary(id: string, body: Partial<CreateLibraryInput>): Promise<MediaLibrary> {
      return request<MediaLibrary>(`/media/libraries/${id}`, { method: 'PATCH', body });
    },
    deleteLibrary(id: string): Promise<void> {
      return request<void>(`/media/libraries/${id}`, { method: 'DELETE' });
    },
    scanLibrary(id: string): Promise<MediaScanResult> {
      return request<MediaScanResult>(`/media/libraries/${id}/scan`, { method: 'POST' });
    },
    listItems(query: MediaItemQuery = {}): Promise<MediaItem[]> {
      return request<MediaItem[]>('/media/items', { query: query as QueryParams });
    },
    getItem(id: string): Promise<MediaItemDetail> {
      return request<MediaItemDetail>(`/media/items/${id}`);
    },
    updateItem(id: string, body: MediaItemUpdateInput): Promise<MediaItem> {
      return request<MediaItem>(`/media/items/${id}`, { method: 'PATCH', body });
    },
    matchItem(id: string, body?: MediaManualMatchInput): Promise<MediaItem> {
      return request<MediaItem>(`/media/items/${id}/match`, { method: 'POST', body: body ?? {} });
    },
    unmatchItem(id: string): Promise<MediaItem> {
      return request<MediaItem>(`/media/items/${id}/unmatch`, { method: 'POST' });
    },
    /** Bulk re-run auto-identification; omit body to re-identify all non-manual items. */
    reidentifyItems(body: MediaReidentifyInput = {}): Promise<MediaReidentifySummary> {
      return request<MediaReidentifySummary>('/media/items/reidentify', { method: 'POST', body });
    },
    // --- metadata ---------------------------------------------------------
    fetchMetadata(id: string): Promise<MediaMetadata> {
      return request<MediaMetadata>(`/media/items/${id}/metadata/fetch`, { method: 'POST' });
    },
    updateMetadata(id: string, body: MediaMetadataUpdateInput): Promise<MediaMetadata> {
      return request<MediaMetadata>(`/media/items/${id}/metadata`, { method: 'PATCH', body });
    },
    // --- artwork ----------------------------------------------------------
    getItemArtwork(id: string): Promise<MediaArtworkList> {
      return request<MediaArtworkList>(`/media/items/${id}/artwork`);
    },
    selectArtwork(id: string, artworkId: string): Promise<MediaArtwork> {
      return request<MediaArtwork>(`/media/items/${id}/artwork/select`, {
        method: 'POST',
        body: { artworkId },
      });
    },
    uploadArtwork(id: string, body: MediaArtworkUploadInput): Promise<MediaArtwork> {
      return request<MediaArtwork>(`/media/items/${id}/artwork/upload`, { method: 'POST', body });
    },
    importArtwork(id: string): Promise<MediaArtworkImportResult> {
      return request<MediaArtworkImportResult>(`/media/items/${id}/artwork/import`, {
        method: 'POST',
      });
    },
    missingArtwork(id: string): Promise<MediaArtworkMissing> {
      return request<MediaArtworkMissing>(`/media/items/${id}/artwork/missing`);
    },
    /**
     * Fetch a locally-stored artwork image as a Blob (bearer-authenticated, so
     * it can't be an `<img src>` directly). Remote artwork uses its `url`.
     */
    async artworkImage(artworkId: string): Promise<Blob> {
      const token = getAccessToken();
      const res = await fetch(buildUrl(`/media/artwork/${artworkId}/image`), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new ApiError(res.status, `Artwork image failed (${res.status})`);
      return res.blob();
    },
    // --- subtitles --------------------------------------------------------
    listSubtitles(id: string): Promise<MediaSubtitle[]> {
      return request<MediaSubtitle[]>(`/media/items/${id}/subtitles`);
    },
    scanSubtitles(id: string): Promise<{ scanned?: number; created?: number } & Record<string, unknown>> {
      return request(`/media/items/${id}/subtitles/scan`, { method: 'POST' });
    },
    missingSubtitles(id: string, preferred?: string): Promise<MediaSubtitleMissing> {
      return request<MediaSubtitleMissing>(`/media/items/${id}/subtitles/missing`, {
        query: preferred ? { preferred } : undefined,
      });
    },
    // --- NFO --------------------------------------------------------------
    generateNfo(itemId: string): Promise<MediaNfoGenerateResult> {
      return request<MediaNfoGenerateResult>('/media/nfo/generate', {
        method: 'POST',
        body: { itemId },
      });
    },
    // --- duplicates -------------------------------------------------------
    listDuplicates(): Promise<MediaDuplicateGroup[]> {
      return request<MediaDuplicateGroup[]>('/media/duplicates');
    },
    detectDuplicates(): Promise<MediaDuplicateGroup[]> {
      return request<MediaDuplicateGroup[]>('/media/duplicates/detect', { method: 'POST' });
    },
    // --- media-server integrations ---------------------------------------
    listServerIntegrations(): Promise<MediaServerIntegration[]> {
      return request<MediaServerIntegration[]>('/media/server-integrations');
    },
    createServerIntegration(body: MediaServerIntegrationInput): Promise<MediaServerIntegration> {
      return request<MediaServerIntegration>('/media/server-integrations', { method: 'POST', body });
    },
    updateServerIntegration(
      id: string,
      body: MediaServerIntegrationInput,
    ): Promise<MediaServerIntegration> {
      return request<MediaServerIntegration>(`/media/server-integrations/${id}`, {
        method: 'PATCH',
        body,
      });
    },
    deleteServerIntegration(id: string): Promise<void> {
      return request<void>(`/media/server-integrations/${id}`, { method: 'DELETE' });
    },
    testServerIntegration(id: string): Promise<MediaServerTestResult> {
      return request<MediaServerTestResult>(`/media/server-integrations/${id}/test`, {
        method: 'POST',
      });
    },
    refreshServerIntegration(id: string): Promise<MediaServerRefreshResult> {
      return request<MediaServerRefreshResult>(`/media/server-integrations/${id}/refresh`, {
        method: 'POST',
      });
    },
    preview(body: RenameRequest): Promise<RenamePlan> {
      return request<RenamePlan>('/media/preview', { method: 'POST', body });
    },
    apply(body: RenameRequest): Promise<RenameApplyResult> {
      return request<RenameApplyResult>('/media/apply', { method: 'POST', body });
    },
    history(): Promise<MediaRenameOperation[]> {
      return request<MediaRenameOperation[]>('/media/history');
    },
    // --- IMDb provider ----------------------------------------------------
    imdbStatus(): Promise<ImdbStatus> {
      return request<ImdbStatus>('/media/providers/imdb/status');
    },
    imdbSettings(): Promise<ImdbSettings> {
      return request<ImdbSettings>('/media/providers/imdb/settings');
    },
    updateImdbSettings(body: ImdbSettingsInput): Promise<ImdbSettings> {
      return request<ImdbSettings>('/media/providers/imdb/settings', { method: 'PATCH', body });
    },
    testImdbApi(): Promise<ImdbApiTestResult> {
      return request<ImdbApiTestResult>('/media/providers/imdb/test', { method: 'POST' });
    },
    testTmdbKey(apiKey?: string): Promise<{ ok: boolean; message: string }> {
      return request<{ ok: boolean; message: string }>('/media/providers/tmdb/test', {
        method: 'POST',
        body: { apiKey },
      });
    },
    validateImdbDataset(body: { datasetPath?: string }): Promise<ImdbDatasetValidationReport> {
      return request<ImdbDatasetValidationReport>('/media/providers/imdb/dataset/validate', {
        method: 'POST',
        body,
      });
    },
    importImdbDataset(body: { datasetPath?: string }): Promise<ImdbDatasetImport> {
      return request<ImdbDatasetImport>('/media/providers/imdb/dataset/import', {
        method: 'POST',
        body,
      });
    },
    imdbImports(): Promise<ImdbDatasetImport[]> {
      return request<ImdbDatasetImport[]>('/media/providers/imdb/dataset/imports');
    },
    /** Cooperatively stop the running import; 404 if none is in progress. */
    stopImdbImport(): Promise<ImdbDatasetImport> {
      return request<ImdbDatasetImport>('/media/providers/imdb/dataset/import/stop', {
        method: 'POST',
      });
    },
    /** Download the configured datasets then import them (detached; WS progress). */
    updateImdbDatasetNow(): Promise<{ started: boolean }> {
      return request<{ started: boolean }>('/media/providers/imdb/dataset/update-now', {
        method: 'POST',
      });
    },
    /** Wipe all imported IMDb data; optionally kick off a fresh import. */
    resetImdbData(
      reimport = false,
    ): Promise<{ clearedTitles: number; reimport: { started: boolean; datasetPath: string | null } | null }> {
      return request('/media/providers/imdb/dataset/reset', {
        method: 'POST',
        body: { reimport },
      });
    },
    imdbSearch(query: ImdbSearchInput): Promise<ImdbSearchResult[]> {
      return request<ImdbSearchResult[]>('/media/providers/imdb/search', {
        query: query as unknown as QueryParams,
      });
    },
    imdbTitle(imdbId: string): Promise<ImdbTitle> {
      return request<ImdbTitle>(`/media/providers/imdb/title/${encodeURIComponent(imdbId)}`);
    },
    matchItemImdb(itemId: string, body: ImdbMatchInput): Promise<ImdbMatchResult> {
      return request<ImdbMatchResult>(`/media/items/${itemId}/match/imdb`, { method: 'POST', body });
    },
  },

  mediaRenamer: {
    analyze(body: { sourceName: string; files: MediaRenamerFileInput[] }): Promise<MediaRenamerAnalyzeResult> {
      return request<MediaRenamerAnalyzeResult>('/media-renamer/analyze', { method: 'POST', body });
    },
    dryRun(body: MediaRenamerRunBody): Promise<MediaRenamerDryRunResult> {
      return request<MediaRenamerDryRunResult>('/media-renamer/dry-run', { method: 'POST', body });
    },
    execute(body: MediaRenamerRunBody): Promise<MediaRenameJobDetail> {
      return request<MediaRenameJobDetail>('/media-renamer/execute', { method: 'POST', body });
    },
    jobs(): Promise<MediaRenameJob[]> {
      return request<MediaRenameJob[]>('/media-renamer/jobs');
    },
    job(id: string): Promise<MediaRenameJobDetail> {
      return request<MediaRenameJobDetail>(`/media-renamer/jobs/${id}`);
    },
    rollback(id: string): Promise<MediaRenamerRollbackResult> {
      return request<MediaRenamerRollbackResult>(`/media-renamer/jobs/${id}/rollback`, { method: 'POST' });
    },
    templates(): Promise<MediaRenamerTemplate[]> {
      return request<MediaRenamerTemplate[]>('/media-renamer/templates');
    },
    createTemplate(body: UpsertMediaRenamerTemplateInput): Promise<MediaRenamerTemplate> {
      return request<MediaRenamerTemplate>('/media-renamer/templates', { method: 'POST', body });
    },
    updateTemplate(id: string, body: Partial<UpsertMediaRenamerTemplateInput>): Promise<MediaRenamerTemplate> {
      return request<MediaRenamerTemplate>(`/media-renamer/templates/${id}`, { method: 'PATCH', body });
    },
    deleteTemplate(id: string): Promise<void> {
      return request<void>(`/media-renamer/templates/${id}`, { method: 'DELETE' });
    },
  },

  releaseScoring: {
    score(body: ReleaseScoreInput): Promise<ReleaseScoreResult> {
      return request<ReleaseScoreResult>('/release-scoring/score', { method: 'POST', body });
    },
    testRule(body: ReleaseTestRuleInput): Promise<ReleaseTestRuleResult> {
      return request<ReleaseTestRuleResult>('/release-scoring/test-rule', { method: 'POST', body });
    },
  },

  mediaAcquisition: {
    overview(): Promise<MediaAcquisitionOverview> {
      return request<MediaAcquisitionOverview>('/media-acquisition/overview');
    },
    watchlist(status?: string): Promise<WatchlistItem[]> {
      return request<WatchlistItem[]>('/media-acquisition/watchlist', { query: { status } });
    },
    watchlistItem(id: string): Promise<WatchlistItem> {
      return request<WatchlistItem>(`/media-acquisition/watchlist/${id}`);
    },
    createWatchlist(body: CreateWatchlistInput): Promise<WatchlistItem> {
      return request<WatchlistItem>('/media-acquisition/watchlist', { method: 'POST', body });
    },
    updateWatchlist(id: string, body: UpdateWatchlistInput): Promise<WatchlistItem> {
      return request<WatchlistItem>(`/media-acquisition/watchlist/${id}`, { method: 'PATCH', body });
    },
    deleteWatchlist(id: string): Promise<void> {
      return request<void>(`/media-acquisition/watchlist/${id}`, { method: 'DELETE' });
    },
    profiles(mediaType?: string): Promise<AcquisitionProfile[]> {
      return request<AcquisitionProfile[]>('/media-acquisition/profiles', { query: { mediaType } });
    },
    profile(id: string): Promise<AcquisitionProfile> {
      return request<AcquisitionProfile>(`/media-acquisition/profiles/${id}`);
    },
    createProfile(body: CreateAcquisitionProfileInput): Promise<AcquisitionProfile> {
      return request<AcquisitionProfile>('/media-acquisition/profiles', { method: 'POST', body });
    },
    updateProfile(
      id: string,
      body: Partial<CreateAcquisitionProfileInput>,
    ): Promise<AcquisitionProfile> {
      return request<AcquisitionProfile>(`/media-acquisition/profiles/${id}`, {
        method: 'PATCH',
        body,
      });
    },
    deleteProfile(id: string): Promise<void> {
      return request<void>(`/media-acquisition/profiles/${id}`, { method: 'DELETE' });
    },
    evaluate(body: EvaluateInput): Promise<AcquisitionEvaluation> {
      return request<AcquisitionEvaluation>('/media-acquisition/evaluate', { method: 'POST', body });
    },
    simulate(body: EvaluateInput): Promise<SimulationResult> {
      return request<SimulationResult>('/media-acquisition/simulate', { method: 'POST', body });
    },
    waiting(): Promise<AcquisitionEvaluation[]> {
      return request<AcquisitionEvaluation[]>('/media-acquisition/waiting');
    },
    upgrades(): Promise<AcquisitionEvaluation[]> {
      return request<AcquisitionEvaluation[]>('/media-acquisition/upgrades');
    },
    rejected(): Promise<AcquisitionEvaluation[]> {
      return request<AcquisitionEvaluation[]>('/media-acquisition/rejected');
    },
    evaluations(
      query: { decision?: string; approvalStatus?: string } = {},
    ): Promise<AcquisitionEvaluation[]> {
      return request<AcquisitionEvaluation[]>('/media-acquisition/evaluations', { query });
    },
    evaluation(id: string): Promise<AcquisitionEvaluationDetail> {
      return request<AcquisitionEvaluationDetail>(`/media-acquisition/evaluations/${id}`);
    },
    approvalQueue(): Promise<AcquisitionEvaluation[]> {
      return request<AcquisitionEvaluation[]>('/media-acquisition/approval-queue');
    },
    approve(id: string): Promise<AcquisitionEvaluation> {
      return request<AcquisitionEvaluation>(`/media-acquisition/evaluations/${id}/approve`, {
        method: 'POST',
      });
    },
    reject(id: string, reason?: string): Promise<AcquisitionEvaluation> {
      return request<AcquisitionEvaluation>(`/media-acquisition/evaluations/${id}/reject`, {
        method: 'POST',
        body: reason ? { reason } : {},
      });
    },
    override(id: string, decision: string, reason?: string): Promise<AcquisitionEvaluation> {
      return request<AcquisitionEvaluation>(`/media-acquisition/evaluations/${id}/override`, {
        method: 'POST',
        body: { decision, ...(reason ? { reason } : {}) },
      });
    },
    // --- missing episodes ---
    missingEpisodes(): Promise<SeriesGapSummary[]> {
      return request<SeriesGapSummary[]>('/media-acquisition/missing-episodes');
    },
    missingEpisodesForSeries(watchlistItemId: string): Promise<WantedEpisode[]> {
      return request<WantedEpisode[]>(`/media-acquisition/missing-episodes/${watchlistItemId}`);
    },
    scanMissingEpisodes(watchlistItemId?: string): Promise<MissingEpisodesScanResult> {
      return request<MissingEpisodesScanResult>('/media-acquisition/missing-episodes/scan', {
        method: 'POST',
        body: watchlistItemId ? { watchlistItemId } : {},
      });
    },
    ignoreMissingEpisode(id: string): Promise<WantedEpisode> {
      return request<WantedEpisode>(`/media-acquisition/missing-episodes/${id}/ignore`, {
        method: 'POST',
      });
    },
    unignoreMissingEpisode(id: string): Promise<WantedEpisode> {
      return request<WantedEpisode>(`/media-acquisition/missing-episodes/${id}/unignore`, {
        method: 'POST',
      });
    },
    history(limit = 100): Promise<AcquisitionHistoryEvent[]> {
      return request<AcquisitionHistoryEvent[]>('/media-acquisition/history', { query: { limit } });
    },
    recommendations(): Promise<AcquisitionRecommendations> {
      return request<AcquisitionRecommendations>('/media-acquisition/recommendations');
    },
    settings(): Promise<AcquisitionSettings> {
      return request<AcquisitionSettings>('/media-acquisition/settings');
    },
    updateSettings(body: Partial<AcquisitionSettings>): Promise<AcquisitionSettings> {
      return request<AcquisitionSettings>('/media-acquisition/settings', { method: 'PATCH', body });
    },
    /** POST /export → JSON blob; triggers a browser download. */
    async export(body: AcquisitionExportInput): Promise<void> {
      const token = getAccessToken();
      const res = await fetch(buildUrl('/media-acquisition/export'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new ApiError(res.status, `Export failed (${res.status})`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `media-acquisition-export-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    },
  },

  mediaServerAnalytics: {
    dashboard(): Promise<MediaServerDashboard> {
      return request<MediaServerDashboard>('/media-server-analytics/dashboard');
    },
    testConnection(id: string): Promise<MediaServerInfo> {
      return request<MediaServerInfo>(`/media-server-analytics/connections/${id}/test`, { method: 'POST' });
    },
    libraries(id: string): Promise<MediaServerLibrariesResult> {
      return request<MediaServerLibrariesResult>(`/media-server-analytics/connections/${id}/libraries`);
    },
    live(): Promise<MediaServerLiveSession[]> {
      return request<MediaServerLiveSession[]>('/media-server-analytics/live');
    },
    /** Now-playing poster for a session, proxied through the provider's auth (bearer-fetched blob). */
    async liveArtwork(sessionId: string): Promise<Blob> {
      const token = getAccessToken();
      const res = await fetch(buildUrl(`/media-server-analytics/live/${sessionId}/artwork`), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new ApiError(res.status, `Live artwork failed (${res.status})`);
      return res.blob();
    },
    watchHistory(): Promise<MediaServerWatchHistoryRow[]> {
      return request<MediaServerWatchHistoryRow[]>('/media-server-analytics/watch-history');
    },
    reportUsage(filter?: MediaAnalyticsFilter): Promise<MediaServerUsageReport> {
      return request<MediaServerUsageReport>(`/media-server-analytics/reports/usage${analyticsQuery(filter)}`);
    },
    reportUsers(filter?: MediaAnalyticsFilter): Promise<MediaServerUserStat[]> {
      return request<MediaServerUserStat[]>(`/media-server-analytics/reports/users${analyticsQuery(filter)}`);
    },
    reportLibraries(filter?: MediaAnalyticsFilter): Promise<MediaServerLibraryStat[]> {
      return request<MediaServerLibraryStat[]>(`/media-server-analytics/reports/libraries${analyticsQuery(filter)}`);
    },
    reportPlayback(filter?: MediaAnalyticsFilter): Promise<MediaServerPlaybackReport> {
      return request<MediaServerPlaybackReport>(`/media-server-analytics/reports/playback${analyticsQuery(filter)}`);
    },
    reportTopMedia(filter?: MediaAnalyticsFilter): Promise<MediaServerTopMedia[]> {
      return request<MediaServerTopMedia[]>(`/media-server-analytics/reports/top-media${analyticsQuery(filter)}`);
    },
    reportDevices(filter?: MediaAnalyticsFilter): Promise<MediaServerDeviceStat[]> {
      return request<MediaServerDeviceStat[]>(`/media-server-analytics/reports/devices${analyticsQuery(filter)}`);
    },
    reportHeatmap(filter?: MediaAnalyticsFilter): Promise<MediaServerHeatmap> {
      return request<MediaServerHeatmap>(`/media-server-analytics/reports/heatmap${analyticsQuery(filter)}`);
    },
    reportTrends(filter?: MediaAnalyticsFilter): Promise<MediaServerTrendPoint[]> {
      return request<MediaServerTrendPoint[]>(`/media-server-analytics/reports/trends${analyticsQuery(filter)}`);
    },
    reportResolutions(filter?: MediaAnalyticsFilter): Promise<MediaServerResolutionStat[]> {
      return request<MediaServerResolutionStat[]>(`/media-server-analytics/reports/resolutions${analyticsQuery(filter)}`);
    },
    reportLibraryGrowth(filter?: MediaAnalyticsFilter): Promise<MediaServerLibraryGrowthPoint[]> {
      return request<MediaServerLibraryGrowthPoint[]>(`/media-server-analytics/reports/library-growth${analyticsQuery(filter)}`);
    },
    reportBandwidth(filter?: MediaAnalyticsFilter): Promise<MediaServerBandwidthPoint[]> {
      return request<MediaServerBandwidthPoint[]>(`/media-server-analytics/reports/bandwidth${analyticsQuery(filter)}`);
    },
    metaLibraries(): Promise<MediaServerLibraryMeta[]> {
      return request<MediaServerLibraryMeta[]>('/media-server-analytics/meta/libraries');
    },
    metaUsers(): Promise<MediaServerUserMeta[]> {
      return request<MediaServerUserMeta[]>('/media-server-analytics/meta/users');
    },
    metaSyncRuns(): Promise<MediaProviderSyncRunRow[]> {
      return request<MediaProviderSyncRunRow[]>('/media-server-analytics/meta/sync-runs');
    },
    runSync(): Promise<{ connections: number; librariesSynced: number; usersSynced: number }> {
      return request('/media-server-analytics/meta/sync', { method: 'POST' });
    },
    /** Download watch-history CSV for the current filter (triggers a browser download). */
    async exportWatchHistoryCsv(filter?: MediaAnalyticsFilter): Promise<void> {
      const token = getAccessToken();
      const res = await fetch(buildUrl(`/media-server-analytics/export/watch-history${analyticsQuery(filter)}`), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new ApiError(res.status, `Export failed (${res.status})`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = 'watch-history.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    },
    recentlyAdded(): Promise<MediaServerRecentlyAddedItem[]> {
      return request<MediaServerRecentlyAddedItem[]>('/media-server-analytics/recently-added');
    },
    importSources(): Promise<AnalyticsImportSource[]> {
      return request<AnalyticsImportSource[]>('/media-server-analytics/import-sources');
    },
    createImportSource(body: { name?: string; baseUrl: string; apiKey?: string }): Promise<AnalyticsImportSource> {
      return request<AnalyticsImportSource>('/media-server-analytics/import-sources', { method: 'POST', body });
    },
    deleteImportSource(id: string): Promise<void> {
      return request<void>(`/media-server-analytics/import-sources/${id}`, { method: 'DELETE' });
    },
    testImportSource(id: string): Promise<{ ok: boolean; message: string }> {
      return request<{ ok: boolean; message: string }>(`/media-server-analytics/import-sources/${id}/test`, { method: 'POST' });
    },
    previewImport(id: string): Promise<AnalyticsImportPreview> {
      return request<AnalyticsImportPreview>(`/media-server-analytics/import-sources/${id}/preview`, { method: 'POST' });
    },
    runImport(id: string): Promise<AnalyticsImportJob> {
      return request<AnalyticsImportJob>(`/media-server-analytics/import-sources/${id}/import`, { method: 'POST' });
    },
    importJobs(): Promise<AnalyticsImportJob[]> {
      return request<AnalyticsImportJob[]>('/media-server-analytics/import-jobs');
    },
    newsletters(): Promise<Newsletter[]> {
      return request<Newsletter[]>('/media-server-analytics/newsletters');
    },
    createNewsletter(body: Partial<Newsletter>): Promise<Newsletter> {
      return request<Newsletter>('/media-server-analytics/newsletters', { method: 'POST', body });
    },
    updateNewsletter(id: string, body: Partial<Newsletter>): Promise<Newsletter> {
      return request<Newsletter>(`/media-server-analytics/newsletters/${id}`, { method: 'PATCH', body });
    },
    deleteNewsletter(id: string): Promise<void> {
      return request<void>(`/media-server-analytics/newsletters/${id}`, { method: 'DELETE' });
    },
    previewNewsletter(id: string): Promise<NewsletterPreview> {
      return request<NewsletterPreview>(`/media-server-analytics/newsletters/${id}/preview`, { method: 'POST' });
    },
    testSendNewsletter(id: string, recipient: string): Promise<{ ok: boolean }> {
      return request<{ ok: boolean }>(`/media-server-analytics/newsletters/${id}/test-send`, { method: 'POST', body: { recipient } });
    },
    sendNewsletter(id: string): Promise<{ sent: number; failed: number }> {
      return request<{ sent: number; failed: number }>(`/media-server-analytics/newsletters/${id}/send-now`, { method: 'POST' });
    },
    emailSettings(): Promise<MediaServerEmailSettings> {
      return request<MediaServerEmailSettings>('/media-server-analytics/settings/email');
    },
    updateEmailSettings(body: Partial<MediaServerEmailSettings> & { password?: string }): Promise<MediaServerEmailSettings> {
      return request<MediaServerEmailSettings>('/media-server-analytics/settings/email', { method: 'PATCH', body });
    },
    testEmail(recipient: string): Promise<{ ok: boolean }> {
      return request<{ ok: boolean }>('/media-server-analytics/settings/email/test', { method: 'POST', body: { recipient } });
    },
  },

};

export interface Newsletter {
  id: string;
  name: string;
  enabled: boolean;
  frequency: string;
  recipientEmails: string[];
  contentSections: string[];
  subjectTemplate: string | null;
  dateRangeMode: string;
  lastDays: number;
  startDate: string | null;
  lastSuccessfulSendAt: string | null;
  nextRunAt: string | null;
}

export interface NewsletterPreview {
  subject: string;
  html: string;
  text: string;
  count: number;
  since: string;
}

export interface MediaServerEmailSettings {
  host: string;
  port: number;
  secure: boolean;
  auth: boolean;
  user: string;
  fromName: string;
  fromAddress: string;
  hasPassword: boolean;
}

export interface AnalyticsImportSource {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  enabled: boolean;
  syncEnabled: boolean;
  hasApiKey: boolean;
  status: string | null;
  lastImportAt: string | null;
}

export interface AnalyticsImportPreview {
  reachable: boolean;
  version?: string;
  totalUsers: number;
  totalHistory: number;
  message?: string;
}

export interface AnalyticsImportJob {
  id: string;
  sourceId: string;
  status: string;
  progress: number;
  totalRecords: number;
  processedRecords: number;
  importedRecords: number;
  skippedRecords: number;
  failedRecords: number;
  createdAt: string;
}

export interface MediaServerUsageReport {
  totalPlays: number;
  totalWatchSeconds: number;
  uniqueUsers: number;
  byDay: { date: string; plays: number }[];
}
export interface MediaServerUserStat {
  userName: string;
  plays: number;
  watchSeconds: number;
  lastSeen: string | null;
}
export interface MediaServerLibraryStat {
  libraryName: string;
  plays: number;
  watchSeconds: number;
}
export interface MediaServerPlaybackReport {
  byMethod: { method: string; plays: number }[];
  byType: { type: string; plays: number }[];
}
/** Lean artwork reference returned inline with analytics rows (subset of MediaArtwork). */
export type MediaArtworkRef = Pick<MediaArtwork, 'id' | 'url' | 'localPath' | 'type' | 'selected'>;

export interface MediaServerRecentlyAddedItem {
  id: string;
  title: string;
  mediaType: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  addedAt: string;
  poster: MediaArtworkRef | null;
}

export interface MediaServerLiveSession {
  id: string;
  connectionId: string;
  userName: string | null;
  title: string;
  mediaType: string | null;
  libraryName: string | null;
  device: string | null;
  client: string | null;
  playbackState: string | null;
  progressPercent: number | null;
  playbackMethod: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  resolution: string | null;
  container: string | null;
  bitrateKbps: number | null;
  artPath: string | null;
  startedAt: string;
}

export interface MediaServerWatchHistoryRow {
  id: string;
  userName: string | null;
  title: string;
  mediaType: string | null;
  libraryName: string | null;
  device: string | null;
  client: string | null;
  startedAt: string;
  stoppedAt: string | null;
  watchedSeconds: number | null;
  percentComplete: number | null;
  playbackMethod: string | null;
  importSource: string | null;
}

export interface MediaServerConnectionSummary {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  isDefault: boolean;
  status: string;
  serverVersion: string | null;
  platform: string | null;
  capabilities: unknown;
  lastHealthCheckAt: string | null;
  lastRefreshAt: string | null;
  notes: string | null;
}

export interface MediaServerDashboard {
  servers: { total: number; enabled: number; online: number; offline: number; byKind: Record<string, number> };
  connections: MediaServerConnectionSummary[];
  kpis: {
    activeStreams: number;
    totalPlays: number;
    totalWatchSeconds: number;
    uniqueUsers: number;
    mediaItems: number;
    recentlyAdded7d: number;
    transcodePct: number;
    directPlayPct: number;
    activeNewsletters: number;
  };
}

export interface MediaServerTopMedia {
  title: string;
  mediaType: string;
  plays: number;
  watchSeconds: number;
}
export interface MediaServerDeviceStat {
  device: string;
  plays: number;
}
export interface MediaServerHeatmap {
  cells: { dow: number; hour: number; plays: number }[];
  max: number;
  total: number;
}
export interface MediaServerTrendPoint {
  date: string;
  directplay: number;
  directstream: number;
  transcode: number;
  other: number;
  total: number;
}
export interface MediaServerResolutionStat {
  resolution: string;
  plays: number;
}
export interface MediaServerLibraryGrowthPoint {
  month: string;
  added: number;
  total: number;
}
export interface MediaServerBandwidthPoint {
  date: string;
  avgKbps: number;
  plays: number;
}
export interface MediaServerLibraryMeta {
  id: string;
  connectionId: string;
  providerLibraryId: string;
  name: string;
  type: string;
  itemCount: number | null;
  lastSyncedAt: string;
}
export interface MediaServerUserMeta {
  id: string;
  connectionId: string | null;
  providerUserId: string | null;
  userName: string;
  plays: number;
  lastSeenAt: string | null;
}
export interface MediaProviderSyncRunRow {
  id: string;
  connectionId: string | null;
  type: string;
  status: string;
  librariesSynced: number;
  usersSynced: number;
  message: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** Dashboard filter applied across analytics report queries. */
export interface MediaAnalyticsFilter {
  /** Rolling window in days; undefined/0 = all-time. */
  days?: number;
  /** Restrict to a single media type (movie/episode/…); undefined = all. */
  mediaType?: string;
  /** Restrict to one media server (connection id); undefined = all. */
  connectionId?: string;
  /** Restrict to one library (by name); undefined = all. */
  libraryName?: string;
  /** Restrict to one viewer (by name); undefined = all. */
  userName?: string;
}

/** Serialize an analytics filter into a query string (empty when no filter). */
function analyticsQuery(filter?: MediaAnalyticsFilter): string {
  if (!filter) return '';
  const params = new URLSearchParams();
  if (filter.days && filter.days > 0) params.set('days', String(filter.days));
  if (filter.mediaType) params.set('mediaType', filter.mediaType);
  if (filter.connectionId) params.set('connectionId', filter.connectionId);
  if (filter.libraryName) params.set('libraryName', filter.libraryName);
  if (filter.userName) params.set('userName', filter.userName);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export interface MediaServerInfo {
  kind: string;
  reachable: boolean;
  name?: string;
  version?: string;
  platform?: string;
  capabilities: Record<string, boolean>;
  message?: string;
}

export interface MediaServerLibrariesResult {
  supported: boolean;
  message?: string;
  libraries: { id: string; name: string; type: string; itemCount?: number }[];
}

export { API_URL };
