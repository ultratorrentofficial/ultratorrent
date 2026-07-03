/**
 * Module registry & licensing contract (public Core).
 *
 * UltraTorrent ships as ONE codebase that runs in multiple editions. Every
 * feature is a *module* declaring a manifest; the registry loads manifests at
 * startup and uses the active LicenseProvider + the dependency graph to decide
 * what is active. The private Enterprise overlay plugs in extra modules and a
 * real license provider without copying Core business logic.
 */

export type ModuleTier = 'core' | 'community' | 'premium' | 'enterprise';

export type Edition = 'community' | 'premium' | 'enterprise';

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
  /** Whether the module is on by default once its tier is permitted. */
  enabledByDefault: boolean;
  /** License feature key that unlocks this module (omitted for core/community). */
  requiredLicenseModule?: string;
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
  /** Whether the active license permits this module. */
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

// --- licensing (public interface only; impl is pluggable) ----------------

export interface LicenseStatus {
  edition: Edition;
  valid: boolean;
  licensee: string | null;
  /** Unlocked license feature keys ('*' means all). */
  modules: string[];
  issuedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
}

/**
 * The seam between the Core module registry and any licensing implementation.
 * Core ships a default {@link Edition} 'community' provider; the private
 * Enterprise overlay supplies a UPLM-backed provider via the same interface.
 */
export interface LicenseProvider {
  getStatus(): Promise<LicenseStatus>;
  hasModule(moduleId: string): Promise<boolean>;
  getModuleLimits(moduleId: string): Promise<Record<string, unknown>>;
  getGlobalLimits(): Promise<Record<string, unknown>>;
}

/**
 * An externally-injected module (e.g. from the Enterprise overlay). The backend
 * and frontend shapes are intentionally opaque (`unknown`) so Core does not
 * depend on Nest/React types in the public contract.
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
  // Community (free, optional)
  MEDIA_RENAMER: 'media_renamer',
  // Core (relocated from premium/enterprise into single-tier community)
  MEDIA_RENAMER_PRO: 'media_renamer_pro',
  MEDIA_MANAGER: 'media_manager',
  RELEASE_SCORING: 'release_scoring',
  MEDIA_ACQUISITION_INTELLIGENCE: 'media_acquisition_intelligence',
  // Premium (license-gated placeholders)
  AI_RELEASE_INTELLIGENCE: 'ai_release_intelligence',
  WORKFLOW_TEMPLATES: 'workflow_templates',
} as const;

export type ModuleId = (typeof MODULE_IDS)[keyof typeof MODULE_IDS];
