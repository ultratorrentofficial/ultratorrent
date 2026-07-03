# Module Registry

UltraTorrent is a single **Community** product. Every feature is a *module* that
declares a **manifest**; the registry loads manifests at startup and uses the
active **license provider** plus the **dependency graph** to decide what is
active. Backend enforcement is authoritative — frontend gating is only UX.

- [Tiers](#tiers)
- [Manifest format](#manifest-format)
- [Module state](#module-state)
- [License provider](#license-provider)
- [API](#api)
- [Backend enforcement](#backend-enforcement)
- [Adding a module](#adding-a-module)

---

## Tiers

| Tier | Meaning | Default license |
|------|---------|-----------------|
| `core` | Always available, **cannot be disabled** (auth, RBAC, engine, torrents, RSS, files, settings, audit, Media Manager, Release Scoring, Media Acquisition Intelligence, …). | permitted |
| `premium` | License-gated modules; denied by the default provider, so they appear **locked**. Currently only planned placeholders (AI Release Intelligence, Workflow Templates). | denied |

The default license provider permits every `core` module and denies `premium`,
so the shipped product runs all core modules and shows premium placeholders as
locked until a provider grants them.

## Manifest format

`packages/shared/src/modules.ts` → `ModuleManifest`. Manifests live in
`apps/backend/src/modules/module-registry/manifests.ts`.

```ts
{
  id: 'rss',
  name: 'RSS automation',
  description: 'Feeds, ranked match candidates, and the Smart Match Builder.',
  version: '1.0.0',
  tier: 'core',
  enabledByDefault: true,
  dependencies: ['auth', 'engine'],
  permissions: ['rss.view', 'rss.manage'],
  menu: [{ label: 'RSS', path: '/rss', icon: 'Rss', permission: 'rss.view' }],
  routes: ['/api/rss'],
  schedulerJobs: ['rss_poll'],
  features: ['smart_match_builder', 'match_preferences'],
}
```

The registry **validates** every manifest at load: schema, that each dependency
references a known module, and that there are **no circular dependencies**
(rejected with a clear error). Declared `permissions` are synced into the
permission catalog so RBAC can assign them.

### Example core module — Media Manager

```ts
{
  id: 'media_manager',
  name: 'Media Manager',
  tier: 'core',
  enabledByDefault: true,
  dependencies: ['auth', 'files'],
  permissions: [
    'media_manager.view', 'media_manager.manage_libraries', 'media_manager.scan',
    'media_manager.match', 'media_manager.edit_metadata', 'media_manager.manage_artwork',
    'media_manager.manage_subtitles', 'media_manager.rename', 'media_manager.move_files',
    'media_manager.generate_nfo', 'media_manager.manage_integrations',
    'media_manager.delete', 'media_manager.admin',
  ],
  menu: [{ label: 'Media', path: '/media', icon: 'Clapperboard', permission: 'media_manager.view' }],
  routes: ['/api/media'],
}
```

Media Manager organizes a media library — library scanning, filename
identification, metadata/artwork/subtitle enrichment, NFO generation, duplicate
detection, media-server integration, and template renaming — behind `/api/media`
and the `media_manager.*` permission block. See
[MEDIA_MANAGER.md](MEDIA_MANAGER.md) for the full guide.

## Module state

For each module the registry computes a `ModuleStatus` with a `state`:

| State | Meaning |
|-------|---------|
| `enabled` | Licensed + dependencies satisfied + turned on. |
| `disabled` | Allowed, but an admin turned it off. |
| `locked` | The tier is not licensed by the active provider. |
| `missing_dependency` | Wants to run but a dependency is off. |

`enabled` requires **all** dependencies to be enabled (computed as a fixpoint),
so disabling a module cascades to its dependents.

## License provider

`LicenseProvider` (in `@ultratorrent/shared`) is the seam between the registry
and any licensing implementation:

```ts
interface LicenseProvider {
  getStatus(): Promise<LicenseStatus>;
  hasModule(moduleId: string): Promise<boolean>;
  getModuleLimits(moduleId: string): Promise<Record<string, unknown>>;
  getGlobalLimits(): Promise<Record<string, unknown>>;
}
```

Core binds the default **`CommunityLicenseProvider`** to the `LICENSE_PROVIDER`
DI token. It permits `core` (and `community`) modules, denies `premium`, needs
no license file, and reports edition `community`. It is the only provider the
product ships — there is no product-key, signature, or external licensing
service.

## API

| Method | Path | Permission |
|--------|------|-----------|
| GET | `/api/modules` | `modules.view` |
| GET | `/api/modules/enabled` | authenticated (drives client nav) |
| GET | `/api/modules/license` | authenticated |
| GET | `/api/modules/:id` | `modules.view` |
| GET | `/api/modules/:id/manifest` | `modules.view` |
| GET | `/api/modules/:id/health` | `modules.view` |
| POST | `/api/modules/:id/enable` | `modules.manage` |
| POST | `/api/modules/:id/disable` | `modules.manage` |

Rules:
- Core modules cannot be disabled.
- A module may be disabled only if no enabled module depends on it.
- Premium modules require a license provider that grants entitlement.
- Enable/disable and access violations are recorded as `module_events` + audit logs.

## Backend enforcement

Decorate a controller (or route) with `@RequiresModule(id)` and add the
`ModuleGuard`. The guard rejects the request with `403` when the module is not
enabled (disabled or unlicensed) and records the violation:

```ts
@Controller('release-scoring')
@RequiresModule(MODULE_IDS.RELEASE_SCORING)
@UseGuards(JwtAuthGuard, PermissionsGuard, ModuleGuard)
export class ReleaseScoringController { /* ... */ }
```

## Adding a module

1. Build the NestJS module as usual (controller/service/DTOs).
2. Add its manifest to `manifests.ts` (tier, deps, permissions, menu, routes).
3. Gate its controller with `@RequiresModule(...)` + `ModuleGuard` if it should
   respect enable/disable.
4. Declare new permissions in `packages/shared/src/permissions.ts` (or rely on
   manifest permission-sync for module-only keys).

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the registry fits into the wider
system, and [BUILD.md](BUILD.md) for building and running the monorepo.
