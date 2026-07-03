/**
 * Public library surface.
 *
 * This barrel exposes the bootstrap factory, the Nest `AppModule`, the module
 * registry service + tokens, and the bundled manifests. It is a single, stable
 * entrypoint for any host or external module that composes on top of the app.
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

// Reusable media/parse/path building blocks (so external modules never
// duplicate the release parser, rename planner, or path safety).
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

// Infrastructure + auth building blocks an external module can reuse via a
// single entrypoint.
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
  ALL_MANIFESTS,
} from './modules/module-registry/manifests';

// Re-export the shared module contracts so external-module code can depend on a
// single entrypoint rather than reaching into @ultratorrent/shared too.
export type {
  LicenseProvider,
  LicenseStatus,
  ModuleManifest,
  ModuleStatus,
  ModuleTier,
  Edition,
} from '@ultratorrent/shared';
