/**
 * Public Core library surface.
 *
 * This barrel is the ONLY thing the private Enterprise overlay imports from the
 * Core backend. It exposes the bootstrap factory, the Nest `AppModule`, the
 * module registry service + tokens, and the bundled manifests — everything the
 * overlay needs to (a) compose itself on top of Core and (b) generate/sign the
 * module catalog. Core never imports anything from the overlay in return.
 */
export {
  createUltraTorrentApp,
  startUltraTorrentApp,
  UltraTorrentAppOptions,
} from './bootstrap';

export { AppModule } from './app.module';

export { ModuleRegistryService } from './modules/module-registry/module-registry.service';
export {
  CommunityLicenseProvider,
  LICENSE_PROVIDER,
} from './modules/module-registry/community-license.provider';
export { ModuleGuard } from './modules/module-registry/module-license.guard';
export { RequiresModule } from './modules/module-registry/module-access.decorator';

// Reusable media/parse/path building blocks for the premium overlays (so they
// never duplicate Core's release parser, rename planner, or path safety).
export {
  buildRenamePlan,
  renderTemplate,
  classifyFile,
  kindFromParsed,
  sanitizeSegment,
  PRESET_TEMPLATES,
} from './modules/media/media-renamer';
export type {
  RenameMode,
  RenameContext,
  RenamePlan,
  RenamePlanItem,
  MediaKind,
  Preset,
  PlanAction,
  MediaFileInput,
  EpisodeMeta,
} from './modules/media/media-renamer';
export { parseTorrentName } from './modules/rss/torrent-name-parser';
export type { ParsedTorrentMeta } from './modules/rss/torrent-name-parser';
export { PathSafety, assertSafeName } from './modules/files/path-safety';
export { EngineRegistryService } from './modules/engine/engine-registry.service';

// Infrastructure + auth building blocks the Enterprise overlay reuses for its
// own controllers/services (so the overlay imports a single Core entrypoint).
export { PrismaService } from './infrastructure/prisma/prisma.service';
export { AuditService } from './modules/audit/audit.service';
export { RealtimeGateway } from './modules/realtime/realtime.gateway';
export { SecretCipher } from './common/crypto/secret-cipher';
export { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
export { PermissionsGuard } from './modules/auth/guards/permissions.guard';
export { RequirePermissions } from './common/decorators/permissions.decorator';
export {
  CurrentUser,
  AuthenticatedUser,
} from './common/decorators/current-user.decorator';

export {
  CORE_MANIFESTS,
  COMMUNITY_MANIFESTS,
  PREMIUM_MANIFESTS,
  ENTERPRISE_MANIFESTS,
  ALL_MANIFESTS,
} from './modules/module-registry/manifests';

// Re-export the shared module/license contracts so overlay code can depend on a
// single Core entrypoint rather than reaching into @ultratorrent/shared too.
export type {
  LicenseProvider,
  LicenseStatus,
  ModuleManifest,
  ModuleStatus,
  ModuleTier,
  Edition,
} from '@ultratorrent/shared';
