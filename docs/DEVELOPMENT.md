# Development Guide

How to work on UltraTorrent: the monorepo layout, the local workflow, and the two
extension points you'll reach for most — **adding a torrent engine provider** and
**adding a module**.

- [Local development workflow](#local-development-workflow)
- [Monorepo layout](#monorepo-layout)
- [Adding a new TorrentEngineProvider](#adding-a-new-torrentengineprovider)
- [Adding a module](#adding-a-module)
- [Testing](#testing)
- [Coding standards](#coding-standards)

---

## Local development workflow

```bash
npm install                 # from the repo root — links all workspaces
npm run prisma:generate     # generate the Prisma client
npm run prisma:migrate      # apply migrations
npm run prisma:seed         # permissions, roles, admin, settings
npm run dev                 # backend (4000) + frontend (5173) together
```

Per-workspace scripts:

| Command | Effect |
|---------|--------|
| `npm run dev:backend` | `nest start --watch` |
| `npm run dev:frontend` | `vite` dev server with `/api` + `/ws` proxy to `:4000` |
| `npm run build` | builds `shared` → `backend` → `frontend` in order |
| `npm run lint` | runs `lint` in every workspace that defines it |
| `npm run test` | runs `test` in every workspace that defines it |
| `npm run prisma:migrate:dev --workspace @ultratorrent/backend` | create + apply a new dev migration |

> The backend depends on the **built or linked** `@ultratorrent/shared` package.
> When editing shared types, run its watch build (`npm run dev --workspace
> @ultratorrent/shared`) or rebuild so the backend/frontend pick up changes.

Swagger lives at `http://localhost:4000/api/docs` for poking at endpoints while
developing.

## Monorepo layout

```
apps/backend     @ultratorrent/backend   NestJS API (Clean Architecture layers)
apps/frontend    @ultratorrent/frontend  React + Vite SPA
packages/shared  @ultratorrent/shared    types, permission catalog, WS events (used by both)
```

Inside `apps/backend/src`, code is organized by Clean Architecture layer:

```
common/          cross-cutting decorators (Public, CurrentUser, RequirePermissions)
config/          typed configuration loader
domain/          framework-free contracts — the TorrentEngineProvider interface
infrastructure/  concrete implementations: engine providers, rtorrent codecs, Prisma
modules/         feature modules: controllers (API) + services (application)
```

The dependency rule: **inner layers never import outer layers.** `domain` imports
nothing framework-specific; `modules` (application/API) depend on `domain`
interfaces; `infrastructure` implements `domain` interfaces. The shared package is
the lingua franca across the whole stack.

## Adding a new TorrentEngineProvider

This is the headline extension point. Because every part of UltraTorrent talks to
engines **only** through the `TorrentEngineProvider` interface, adding qBittorrent,
Transmission, or Deluge touches just two files — and **no** controllers, services,
DTOs, or UI.

### 1. Implement the interface

Create `src/infrastructure/engine/<engine>/<engine>.provider.ts` implementing
`TorrentEngineProvider` (`src/domain/engine/torrent-engine-provider.interface.ts`).

```ts
import {
  EngineKind, NormalizedTorrent, /* …all Normalized* + stats types… */
} from '@ultratorrent/shared';
import {
  EngineConnectionConfig,
  TorrentEngineProvider,
} from '../../../domain/engine/torrent-engine-provider.interface';

export class QbittorrentProvider implements TorrentEngineProvider {
  readonly kind: EngineKind = 'qbittorrent';
  readonly engineId: string;

  constructor(cfg: EngineConnectionConfig) {
    this.engineId = cfg.engineId;
    // build your transport/client from cfg (host/port/url/socketPath/timeoutMs)
  }

  async connect(): Promise<void> { /* … */ }
  async disconnect(): Promise<void> { /* … */ }
  async healthCheck(): Promise<EngineHealth> { /* { online, latencyMs, version, error, checkedAt } */ }

  async listTorrents(): Promise<NormalizedTorrent[]> {
    // 1. call the engine's native API
    // 2. MAP each native record into a NormalizedTorrent (lowercase info-hash,
    //    progress 0..1, rates in bytes/sec, ISO timestamps, mapped TorrentState)
  }
  // …implement every method on the interface…
}
```

**The golden rule:** map the engine's native representation into the
`Normalized*` shapes (`packages/shared/src/torrent.ts`). Never let an
engine-specific field escape the provider. Capabilities the engine genuinely
cannot support should `throw` a clear "not supported" error (as
`RTorrentProvider.renameFile` does), so the application layer can degrade
gracefully. Use `RTorrentProvider` as the reference implementation.

### 2. Register it in the factory

Add a `case` to `EngineProviderFactory`
(`src/infrastructure/engine/engine-provider.factory.ts`):

```ts
switch (config.kind) {
  case 'rtorrent':
    return new RTorrentProvider(config);
  case 'qbittorrent':
    return new QbittorrentProvider(config);   // ← new
  case 'transmission':
  case 'deluge':
    throw new Error(`Engine "${config.kind}" is planned but not yet implemented`);
  default:
    throw new Error(`Unknown engine kind: ${config.kind}`);
}
```

That's it. `EngineRegistryService` builds provider instances from stored
`TorrentEngine` rows via this factory, and `TorrentsService` / `DashboardService`
/ `TorrentSyncService` immediately work against the new engine — they only ever
saw the interface. The `EngineKind` union and the engine DTO already include the
new kind, so the create-engine endpoint accepts it once the provider exists.

> If the engine needs new transport details, extend `EngineConnectionConfig`
> (domain) and the `EngineConnectionDto` (engine module DTO) rather than smuggling
> engine-specific fields into business logic.

## Adding a module

Feature modules live under `src/modules/<feature>/`. A typical module:

```
modules/<feature>/
├── <feature>.module.ts        # @Module wiring
├── <feature>.controller.ts    # API layer — thin, declares permissions
├── <feature>.service.ts       # application layer — the actual logic
└── dto/<feature>.dto.ts        # class-validator request DTOs
```

1. **Service (application).** Put the logic here. Depend on `PrismaService`,
   `EngineRegistryService`, `AuditService`, etc. — never on a concrete provider.
2. **Controller (API).** Keep it thin: bind routes to service calls, attach
   `@UseGuards(JwtAuthGuard, PermissionsGuard)`, declare `@RequirePermissions(...)`
   from the shared catalog, and add Swagger decorators (`@ApiTags`,
   `@ApiBearerAuth`). Use the `@CurrentUser()` decorator to access the principal.
3. **DTOs.** Validate every input with `class-validator`.
4. **New permission?** Add it to `packages/shared/src/permissions.ts`, map it into
   the relevant `ROLE_PERMISSIONS` entries, and re-run `npm run prisma:seed` so the
   permission row and role mappings exist.
5. **Module.** Register providers/controllers in the `@Module`. Mark it `@Global()`
   only if other modules need its exports app-wide (as `EngineModule`,
   `AuditModule`, and `RealtimeModule` do). Register the module in the app's root
   module.
6. **Audit destructive actions** by calling `AuditService.record(...)` from the
   service.

Follow the existing modules (`torrents`, `engine`, `audit`) as templates.

## Testing

The backend is configured for **Jest** with `ts-jest`:

```bash
npm run test --workspace @ultratorrent/backend          # run once
npm run test:watch --workspace @ultratorrent/backend    # watch mode
npm run test:cov --workspace @ultratorrent/backend      # coverage
```

- Test files are `*.spec.ts` under `src` (`testRegex: '.*\\.spec\\.ts$'`).
- `@ultratorrent/shared` is mapped to its source so tests see live shared types.
- Good first targets for unit tests: the XML-RPC codec (`buildMethodCall` /
  `parseMethodResponse`), the bencode info-hash reader, `RTorrentProvider`'s state
  and priority mapping (pure functions, no I/O), and the `PermissionsGuard`.
- Lint before pushing: `npm run lint` (ESLint, `--max-warnings 0`).

## Coding standards

- **Clean Architecture, enforced by imports.** Domain stays framework-free.
  Application services depend on domain interfaces, not infrastructure. The UI and
  application code never reference rTorrent/engine-specific types.
- **No business logic in controllers.** Controllers validate, authorize, and
  delegate. All real work lives in services.
- **Normalize provider data.** Providers translate native engine data into the
  `Normalized*` DTOs and never leak raw fields upward. Unsupported capabilities
  throw an explicit error.
- **Permissions from the catalog.** Always guard routes with
  `@RequirePermissions(PERMISSIONS.*)` using the shared constants — don't invent
  ad-hoc strings.
- **Audit the dangerous stuff.** Any create/delete/state-change/security action
  records an audit entry.
- **Validate all input** with DTOs; never trust query/body values directly.
- **TypeScript strict mode** is on (`strict`, `noImplicitAny`,
  `noFallthroughCasesInSwitch`, …). Keep it warning-clean.
- **Shared first.** Types, permissions, and event names that both API and UI need
  belong in `@ultratorrent/shared`, not duplicated.

## Modules

UltraTorrent is a single-tier community product — one codebase, no edition
branches. See [MODULES.md](MODULES.md) for the module model.

- **Every feature is a module** with a manifest in
  `apps/backend/src/modules/module-registry/manifests.ts` (tier, dependencies,
  permissions, menu, routes). The registry validates them at startup and rejects
  circular dependencies.
- **Gate endpoints with RBAC** — `@UseGuards(JwtAuthGuard, PermissionsGuard)` +
  `@RequirePermissions(...)`. The registry's enable/disable state drives client
  navigation (via `/api/modules/enabled`); the server always enforces permissions.
- **Availability** goes through the `LicenseProvider` seam. The app binds the
  default `CommunityLicenseProvider`, under which every `core`/`community` module
  is available.
- **Build & run:** `npm run build` builds shared → backend → frontend; `npm run
  dev` runs the API plus the Vite dev server.
</content>
