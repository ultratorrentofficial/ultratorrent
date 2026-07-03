/**
 * Module registry contract.
 *
 * UltraTorrent ships as a single-tier, fully-community product. Every feature is
 * a *module* declaring a manifest; the registry loads manifests at startup and
 * uses the dependency graph (plus an optional per-module enable/disable flag) to
 * decide what is active. Access to a module's routes is governed by RBAC.
 */

export type ModuleTier = 'core' | 'community';

export type Edition = 'community';

export interface ModuleMenuItem {
  label: string;
  path: string;
  icon: string;
  permission?: string;
}

export interface ModuleManifest {
  id: string;
  name: string;
  description: string;
  tier: ModuleTier;
  /** Whether the module is on by default. */
  enabledByDefault: boolean;
  dependencies: string[];
  permissions: string[];
  menu?: ModuleMenuItem[];
  routes?: string[];
  websocketEvents?: string[];
  schedulerJobs?: string[];
  settingsSections?: string[];
  features?: string[];
}

/** Computed runtime state of a module. */
export type ModuleStateValue =
  | 'available'
  | 'enabled'
  | 'disabled'
  | 'locked'
  | 'missing_dependency'
  | 'license_required';

export interface ModuleStatus {
  id: string;
  name: string;
  description: string;
  tier: ModuleTier;
  state: ModuleStateValue;
  enabled: boolean;
  /** Whether this module is available in the current build (always true). */
  licensed: boolean;
  dependencies: string[];
  /** Dependencies that are not currently satisfied (enabled). */
  unmetDependencies: string[];
  permissions: string[];
  menu: ModuleMenuItem[];
  features: string[];
  /** True for core modules, which can never be disabled. */
  locked: boolean;
  /** Human-readable explanation of the current state. */
  reason: string;
}

// --- module availability (single-tier; the whole product is community) ----

export interface LicenseStatus {
  edition: Edition;
  valid: boolean;
  licensee: string | null;
  /** Available module keys ('*' means all). */
  modules: string[];
  issuedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
}

/**
 * The seam the module registry consults to decide whether a module is available.
 * The single-tier community build makes every module available; the interface is
 * kept as a small pluggable seam so the availability rule lives in one place.
 */
export interface LicenseProvider {
  getStatus(): Promise<LicenseStatus>;
  hasModule(moduleId: string): Promise<boolean>;
  getModuleLimits(moduleId: string): Promise<Record<string, unknown>>;
  getGlobalLimits(): Promise<Record<string, unknown>>;
}

/**
 * An externally-injected module. The backend and frontend shapes are
 * intentionally opaque (`unknown`) so the shared contract does not depend on
 * Nest/React types.
 */
export interface UltraTorrentExternalModule {
  manifest: ModuleManifest;
  backendModule?: unknown;
  frontendRoutes?: unknown[];
  frontendMenuItems?: unknown[];
}

/** Canonical module ids (kept in sync with the backend manifests). */
export const MODULE_IDS = {
  // Core
  AUTH: 'auth',
  USERS: 'users',
  RBAC: 'rbac',
  ENGINE: 'engine',
  DASHBOARD: 'dashboard',
  TORRENTS: 'torrents',
  RSS: 'rss',
  AUTOMATION: 'automation',
  FILES: 'files',
  SETTINGS: 'settings',
  AUDIT: 'audit',
  NOTIFICATIONS: 'notifications',
  API_KEYS: 'api_keys',
  SYSTEM: 'system',
  SEARCH: 'search',
  TAXONOMY: 'taxonomy',
  ACCOUNT: 'account',
  MODULE_REGISTRY: 'module_registry',
  // Community (optional, on by default)
  MEDIA_RENAMER: 'media_renamer',
  MEDIA_MANAGER: 'media_manager',
  RELEASE_SCORING: 'release_scoring',
  MEDIA_ACQUISITION_INTELLIGENCE: 'media_acquisition_intelligence',
} as const;

export type ModuleId = (typeof MODULE_IDS)[keyof typeof MODULE_IDS];
