# Module Registry

UltraTorrent is a single **Community** product. Every feature is a *module* that
declares a **manifest**; the registry loads manifests at startup and uses the
**dependency graph** (plus an optional per-module enable/disable flag) to decide
what is active. Access to a module's routes is governed by RBAC.

- [Tiers](#tiers)
- [Manifest format](#manifest-format)
- [Module state](#module-state)
- [Availability provider](#availability-provider)
- [API](#api)
- [Access control](#access-control)
- [Adding a module](#adding-a-module)

---

## Tiers

| Tier | Meaning |
|------|---------|
| `core` | Always available, **cannot be disabled** (auth, RBAC, engine, torrents, RSS, files, settings, audit, …). |
| `community` | Bundled optional modules, on by default but **toggleable** by an admin (Media Manager, Release Scoring, Media Acquisition Intelligence, …). |

Every module is `core` or `community`, and every module is available in the
single-tier product — there is no licensing, product key, or gated tier.

## Manifest format

`packages/shared/src/modules.ts` → `ModuleManifest`. Manifests live in
`apps/backend/src/modules/module-registry/manifests.ts`.

```ts
{
  id: 'rss',
  name: 'RSS automation',
  description: 'Feeds, ranked match candidates, and the Smart Match Builder.',
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

### Example community module — Media Manager

```ts
{
  id: 'media_manager',
  name: 'Media Manager',
  tier: 'community',
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
| `enabled` | Dependencies satisfied + turned on. |
| `disabled` | Allowed, but an admin turned it off. |
| `missing_dependency` | Wants to run but a dependency is off. |

`enabled` requires **all** dependencies to be enabled (computed as a fixpoint),
so disabling a module cascades to its dependents.

## Availability provider

There is **no licensing, edition, or feature gating** in UltraTorrent — every
module is available in this single community product and access is governed only
by RBAC. The registry still consults a small **availability seam** so it always
has a single answer to "is this module available?"; in this product that answer
is always *yes*. The interface (named `LicenseProvider` in `@ultratorrent/shared`
for historical/compatibility reasons) is:

```ts
interface LicenseProvider {
  getStatus(): Promise<LicenseStatus>;
  hasModule(moduleId: string): Promise<boolean>;
  getModuleLimits(moduleId: string): Promise<Record<string, unknown>>;
  getGlobalLimits(): Promise<Record<string, unknown>>;
}
```

The product binds the default **`CommunityLicenseProvider`** to the
`LICENSE_PROVIDER` DI token. Every `core`/`community` module is available, it
needs no license file, and it reports `community` as the single product
identifier. It is the only provider the product ships — there is no product key,
signature, tier, or external service, and nothing is ever gated or paywalled.
See [ARCHITECTURE.md → Provider Architecture](ARCHITECTURE.md#provider-architecture)
for how provider seams isolate external services more generally.

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
- Enable/disable actions are recorded as `module_events` + audit logs.

## Access control

Module routes are protected by RBAC — `@UseGuards(JwtAuthGuard, PermissionsGuard)`
plus `@RequirePermissions(...)` on each controller/route. The registry's
enable/disable state drives the client navigation and route gating so a disabled
module's UI is hidden; the authoritative access decision on the backend is RBAC.

## Adding a module

1. Build the NestJS module as usual (controller/service/DTOs).
2. Add its manifest to `manifests.ts` (tier, deps, permissions, menu, routes).
3. Guard its controller with `@UseGuards(JwtAuthGuard, PermissionsGuard)` and
   `@RequirePermissions(...)`.
4. Declare new permissions in `packages/shared/src/permissions.ts` (or rely on
   manifest permission-sync for module-only keys).

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the registry fits into the wider
system, and [BUILD.md](BUILD.md) for building and running the monorepo.
