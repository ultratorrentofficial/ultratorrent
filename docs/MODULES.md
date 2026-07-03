# Module Registry

UltraTorrent is **one codebase** that runs in multiple editions. Every feature
is a *module* that declares a **manifest**; the registry loads manifests at
startup and uses the active **license provider** plus the **dependency graph**
to decide what is active. Backend enforcement is authoritative — frontend
gating is only UX.

- [Tiers](#tiers)
- [Manifest format](#manifest-format)
- [Module state](#module-state)
- [License provider](#license-provider)
- [API](#api)
- [Backend enforcement](#backend-enforcement)
- [Adding a module](#adding-a-module)
- [External (Enterprise) module injection](#external-enterprise-module-injection)

---

## Tiers

| Tier | Meaning | Default license |
|------|---------|-----------------|
| `core` | Always available, **cannot be disabled** (auth, RBAC, engine, torrents, RSS, files, settings, audit, …). | always |
| `community` | Free, optional modules; on by default, may be disabled. | always |
| `premium` | License-gated features (multi-server, advanced analytics, …). | denied in community |
| `enterprise` | Fleet/hosting modules (fleet management, node registry, billing, …). | denied in community |

The public Core ships `core` + `community` modules and **placeholder** manifests
for `premium`/`enterprise`. Their real implementations live in the private
Enterprise overlay and are injected at runtime — Core never imports them.

## Manifest format

`packages/shared/src/modules.ts` → `ModuleManifest`. Manifests live in
`apps/backend/src/modules/module-registry/manifests.ts`.

```ts
{
  id: 'fleet_management',
  name: 'Fleet Management',
  description: 'Manage multiple UltraTorrent nodes centrally.',
  version: '1.0.0',
  tier: 'enterprise',
  enabledByDefault: false,
  requiredLicenseModule: 'fleet_management',
  dependencies: ['auth', 'rbac', 'users', 'notifications', 'api_keys'],
  permissions: ['fleet.view', 'fleet.manage'],
  menu: [{ label: 'Fleet', path: '/fleet', icon: 'Network', permission: 'fleet.view' }],
  routes: ['/api/fleet', '/api/nodes'],
  websocketEvents: ['fleet.node.registered', 'fleet.node.heartbeat'],
  schedulerJobs: ['fleet_health_sweep'],
  settingsSections: ['fleet'],
  features: ['provisioning'],
}
```

The registry **validates** every manifest at load: schema, that each dependency
references a known module, and that there are **no circular dependencies**
(rejected with a clear error). Declared `permissions` are synced into the
permission catalog so RBAC can assign them.

## Module state

For each module the registry computes a `ModuleStatus` with a `state`:

| State | Meaning |
|-------|---------|
| `enabled` | Licensed + dependencies satisfied + turned on. |
| `disabled` | Allowed, but an admin turned it off. |
| `locked` | The tier is not licensed in this edition. |
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
DI token. It permits `core` + `community`, denies `premium` + `enterprise`, needs
no license file, and reports edition `community`. The private Enterprise overlay
swaps in a UPLM-backed provider at bootstrap to unlock higher tiers — no Core
changes required.

The runtime swap uses Core's `ModuleRegistryService.setLicenseProvider()` seam
(Core exposes the seam but never imports the overlay). The overlay's
`LicenseProviderImpl` is **fail-closed**: with no operational license,
`hasModule()` is `false` for every Premium/Enterprise module. See
[UPLM.md](UPLM.md) for the licensing authority, signing, and verification model.

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
- Community modules may be disabled only if no enabled module depends on them.
- Premium/Enterprise modules require a license provider that grants entitlement.
- Enable/disable and access violations are recorded as `module_events` + audit logs.

## Backend enforcement

Decorate a controller (or route) with `@RequiresModule(id)` and add the
`ModuleGuard`. The guard rejects the request with `403` when the module is not
enabled (disabled or unlicensed) and records the violation:

```ts
@Controller('media')
@RequiresModule(MODULE_IDS.MEDIA_RENAMER)
@UseGuards(JwtAuthGuard, PermissionsGuard, ModuleGuard)
export class MediaController { /* ... */ }
```

## Adding a module

1. Build the NestJS module as usual (controller/service/DTOs).
2. Add its manifest to `manifests.ts` (tier, deps, permissions, menu, routes).
3. Gate its controller with `@RequiresModule(...)` + `ModuleGuard` if it should
   respect enable/disable.
4. Declare new permissions in `packages/shared/src/permissions.ts` (or rely on
   manifest permission-sync for module-only keys).

## External (Enterprise) module injection

The private overlay provides an `UltraTorrentExternalModule { manifest,
backendModule?, frontendRoutes?, frontendMenuItems? }`. At runtime it calls
`ModuleRegistryService.registerExternal(manifest)` and binds its own
`LicenseProvider`. Core stays free of any enterprise dependency, and the
**community build succeeds without the enterprise package installed**
(`npm run build:community`).

Premium/enterprise modules are **registered but locked** in Core (manifest
placeholders, no implementation); the overlay supplies the implementation and is
discovered when loaded (`externalModules` at bootstrap). The Community↔Enterprise
repository split, build profiles, and this overlay/discovery mechanism are
documented in [BUILD.md](BUILD.md).
