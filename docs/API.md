# REST API Reference

This document describes UltraTorrent's HTTP API, grouped by module and derived
directly from the NestJS controllers.

- [Conventions](#conventions)
- [Interactive docs (OpenAPI / Swagger)](#interactive-docs-openapi--swagger)
- [Authentication](#authentication)
- [Auth — `/api/auth`](#auth--apiauth)
- [Torrents — `/api/torrents`](#torrents--apitorrents)
- [Dashboard — `/api/dashboard`](#dashboard--apidashboard)
- [Search — `/api/search`](#search--apisearch)
- [Engines — `/api/engines`](#engines--apiengines)
- [Categories & Tags — `/api/categories`, `/api/tags`](#categories--tags--apicategories-apitags)
- [Files — `/api/files`](#files--apifiles)
- [RSS — `/api/rss`](#rss--apirss)
- [Automation — `/api/automation`](#automation--apiautomation)
- [Notifications — `/api/notifications`](#notifications--apinotifications)
- [Settings — `/api/settings`](#settings--apisettings)
- [Users & Roles — `/api/users`](#users--roles--apiusers)
- [API keys — `/api/api-keys`](#api-keys--apiapi-keys)
- [Audit — `/api/audit`](#audit--apiaudit)
- [System — `/api/system`](#system--apisystem)
- [WebSocket API](#websocket-api)
- [Not yet exposed](#not-yet-exposed)

---

## Conventions

- **Base path.** A global prefix of **`/api`** is applied in `main.ts`
  (`app.setGlobalPrefix('api')`), so every route below is served under `/api`
  (e.g. `POST /api/auth/login`).
- **Validation.** A global `ValidationPipe` runs with `whitelist: true`,
  `forbidNonWhitelisted: true`, and `transform: true` — unknown body properties
  are rejected with `400`, and primitives are coerced to their DTO types.
- **Permissions.** Routes that list a required permission are protected by
  `JwtAuthGuard` + `PermissionsGuard`. The caller must hold the named permission
  (a `SUPER_ADMIN` bypasses the check). Missing permissions yield `403` with a
  `Missing permission(s): …` message.
- **`engineId`.** Most torrent/engine routes accept an optional `engineId`. When
  omitted, the request resolves to the configured **default** engine.
- **Pagination.** Paginated endpoints return `{ items, total, page, pageSize }`.
- **BigInt.** Torrent byte sizes are 64-bit; a global `BigInt.toJSON` shim
  serializes them as strings in responses.
- **Rate limiting.** A global throttler allows 120 requests / 60 s by default;
  auth endpoints have tighter explicit limits.

## Interactive docs (OpenAPI / Swagger)

A live, interactive OpenAPI explorer is generated from the controllers (via
`@nestjs/swagger`, `SwaggerModule.setup('api/docs', …)`) and served at:

```
GET /api/docs
```

Controllers are grouped by `@ApiTags` and protected routes carry the
bearer-auth scheme. Use the "Authorize" button to paste an access token.

## Authentication

UltraTorrent uses **JWT bearer** authentication. Obtain tokens from
`POST /api/auth/login`, then send the access token on every protected request:

```
Authorization: Bearer <accessToken>
```

Access tokens are short-lived (`15m` by default). When one expires, exchange the
**refresh token** at `POST /api/auth/refresh` for a fresh pair (the refresh token
is rotated — see [SECURITY.md](SECURITY.md#tokens)).

---

## Auth — `/api/auth`

`@Controller('auth')` — tag `auth`.

| Method | Path | Auth | Permission | Body |
|--------|------|------|------------|------|
| `POST` | `/api/auth/login` | Public · rate-limited 5/min | — | `{ username, password }` |
| `POST` | `/api/auth/refresh` | Public · rate-limited 20/min | — | `{ refreshToken }` |
| `POST` | `/api/auth/logout` | Bearer | — | `{ refreshToken }` |
| `GET`  | `/api/auth/me` | Bearer | — | — |
| `POST` | `/api/auth/change-password` | Bearer | — | `{ currentPassword, newPassword }` |

**`POST /api/auth/login`** — authenticate and obtain access + refresh tokens.

```json
// request
{ "username": "admin", "password": "changeme123!" }

// response
{
  "accessToken": "eyJ...",
  "refreshToken": "<family>.<secret>",
  "expiresIn": 900,
  "user": {
    "id": "uuid", "username": "admin", "email": "admin@ultratorrent.local",
    "displayName": "Administrator",
    "roles": ["SUPER_ADMIN"], "permissions": ["torrents.view", "..."],
    "isActive": true
  }
}
```

**`POST /api/auth/refresh`** — rotate the refresh token and get a fresh access
token. Body: `{ "refreshToken": "<family>.<secret>" }`. Returns the same shape as
login. Reusing an already-rotated token invalidates the whole token family
(reuse detection).

**`POST /api/auth/logout`** — revokes the supplied refresh token. Returns
`{ "success": true }`.

**`GET /api/auth/me`** — returns the current `AuthUser` (id, username, email,
roles, flattened permissions).

**`POST /api/auth/change-password`** — `newPassword` must be 10–256 characters.
Changing the password revokes all of the user's existing refresh tokens.

---

## Torrents — `/api/torrents`

`@Controller('torrents')` guarded by `JwtAuthGuard` + `PermissionsGuard` — tag
`torrents`. All routes accept an optional `engineId` (query or body) selecting
the target engine.

### Reads

| Method | Path | Permission | Query |
|--------|------|------------|-------|
| `GET` | `/api/torrents` | `torrents.view` | `engineId`, `state`, `category`, `search`, `sortBy`, `sortDir` (`asc`\|`desc`), `page`, `pageSize` |
| `GET` | `/api/torrents/:hash` | `torrents.view` | `engineId` |
| `GET` | `/api/torrents/:hash/files` | `torrents.view` | `engineId` |
| `GET` | `/api/torrents/:hash/peers` | `torrents.view` | `engineId` |
| `GET` | `/api/torrents/:hash/trackers` | `torrents.view` | `engineId` |

`GET /api/torrents` returns a paginated list of `NormalizedTorrent` items.
Filtering and sorting are server-side; `pageSize` is capped at 500 (default 50).
The `:hash` is the lowercase info-hash.

### Adding

| Method | Path | Permission | Body |
|--------|------|------------|------|
| `POST` | `/api/torrents` | `torrents.add` | `AddTorrentDto` (JSON) |
| `POST` | `/api/torrents/upload` | `torrents.add` | `multipart/form-data`: `file` (.torrent, ≤ 20 MB) + `AddTorrentDto` fields |

**`AddTorrentDto`** (all optional; provide exactly one source — `magnet`, `url`,
or an uploaded `file`):

```ts
{
  magnet?: string;
  url?: string;                    // remote .torrent URL
  engineId?: string;
  category?: string;
  tags?: string[];
  savePath?: string;
  startPaused?: boolean;
  sequentialDownload?: boolean;
  firstLastPiecePriority?: boolean;
  uploadLimit?: number;            // bytes/sec, ≥ 0
  downloadLimit?: number;          // bytes/sec, ≥ 0
}
```

Both return `{ "hash": "<info-hash>" }`.

### Bulk

| Method | Path | Permission | Body |
|--------|------|------------|------|
| `POST` | `/api/torrents/bulk` | `torrents.view` | `{ hashes: string[], action, engineId? }` |

`action` is one of `start`, `stop`, `pause`, `resume`, `recheck`, `remove`,
`removeData`. Returns `{ succeeded, failed }` counts. The bulk route is gated only
by `torrents.view`; the per-hash routes below enforce the action-specific
permission.

### State transitions & mutations

| Method | Path | Permission | Body / Query |
|--------|------|------------|--------------|
| `POST`   | `/api/torrents/:hash/start` | `torrents.start` | `engineId` (query) |
| `POST`   | `/api/torrents/:hash/stop` | `torrents.stop` | `engineId` (query) |
| `POST`   | `/api/torrents/:hash/pause` | `torrents.pause` | `engineId` (query) |
| `POST`   | `/api/torrents/:hash/resume` | `torrents.resume` | `engineId` (query) |
| `POST`   | `/api/torrents/:hash/recheck` | `torrents.recheck` | `engineId` (query) |
| `DELETE` | `/api/torrents/:hash` | `torrents.delete` | `engineId` (query) |
| `DELETE` | `/api/torrents/:hash/data` | `torrents.delete_data` | `engineId` (query) |
| `POST`   | `/api/torrents/:hash/move` | `torrents.move` | `{ destination, engineId? }` |
| `POST`   | `/api/torrents/:hash/limits/upload` | `torrents.manage_limits` | `{ bytesPerSec, engineId? }` |
| `POST`   | `/api/torrents/:hash/limits/download` | `torrents.manage_limits` | `{ bytesPerSec, engineId? }` |
| `POST`   | `/api/torrents/:hash/files/priority` | `torrents.manage_files` | `{ fileIndex, priority (0\|1\|2), engineId? }` |
| `POST`   | `/api/torrents/:hash/trackers` | `torrents.manage_trackers` | `{ url, engineId? }` |
| `DELETE` | `/api/torrents/:hash/trackers` | `torrents.manage_trackers` | `{ url, engineId? }` |

State-transition and mutation routes return `{ "success": true }`. `DELETE
…/data` removes the torrent **and its files on disk**. File `priority` maps to
`FilePriority`: `0` = skip, `1` = normal, `2` = high.

---

## Dashboard — `/api/dashboard`

`@Controller('dashboard')` guarded — tag `dashboard`.

| Method | Path | Permission | Query |
|--------|------|------------|-------|
| `GET` | `/api/dashboard/summary` | `torrents.view` | `engineId` |
| `GET` | `/api/dashboard/activity` | `torrents.view` | — |

**`GET /api/dashboard/summary`** — aggregated snapshot for the (default or
specified) engine: `engineOnline`, `downloadRate`, `uploadRate`,
`totalTorrents`, `downloading`, `paused`, `completed`, `seeding`, `errored`,
`ratio`, `totalUploaded`, `totalDownloaded`.

**`GET /api/dashboard/activity`** — the 15 most recent audit-log entries
(including the acting username) for the activity feed.

---

## Search — `/api/search`

`@Controller('search')` guarded — tag `search`.

| Method | Path | Permission | Query |
|--------|------|------------|-------|
| `GET` | `/api/search` | `torrents.view` | `q` (required), `limit` (default 50) |

Full-text-ish search across persisted `TorrentSnapshot` rows by `name`, `hash`,
`label`, and `savePath` (case-insensitive). Returns `{ items: [...] }` with BigInt
fields serialized as strings. An empty `q` returns `{ items: [] }`.

---

## Engines — `/api/engines`

`@Controller('engines')` guarded — tag `engines`.

| Method | Path | Permission | Body / Query |
|--------|------|------------|--------------|
| `GET`    | `/api/engines` | `system.view` | — |
| `GET`    | `/api/engines/health` | `system.view` | `engineId` (query, optional) |
| `POST`   | `/api/engines` | `engines.manage` | `CreateEngineDto` |
| `PATCH`  | `/api/engines/:id` | `engines.manage` | `UpdateEngineDto` |
| `DELETE` | `/api/engines/:id` | `engines.manage` | — |

**`GET /api/engines`** lists configured engines with **secrets stripped**
(`id`, `name`, `kind`, `isDefault`, `isEnabled`, `mode`). **`GET
/api/engines/health`** returns `EngineHealth`
(`{ online, latencyMs, version, error, checkedAt }`).

**`CreateEngineDto`**:

```ts
{
  name: string;                                    // ≤ 120 chars
  kind: 'rtorrent'|'qbittorrent'|'transmission'|'deluge';
  config: {                                        // EngineConnectionDto
    mode: 'scgi-tcp'|'scgi-unix'|'http';
    host?: string; port?: number;
    socketPath?: string; url?: string;
    timeoutMs?: number;
  };
  isDefault?: boolean;                             // unsets others when true
  isEnabled?: boolean;
}
```

`UpdateEngineDto` is the same with all fields optional (no `kind`). Create /
update / delete reload the live provider registry. Returns
`{ "id": "<engine-id>" }`.

> Only `kind: "rtorrent"` is implemented today; the other kinds pass validation
> but the provider factory throws "planned but not yet implemented".

---

## Categories & Tags — `/api/categories`, `/api/tags`

`@Controller()` (`TaxonomyController`) guarded — tag `taxonomy`.

| Method | Path | Permission | Body |
|--------|------|------------|------|
| `GET`    | `/api/categories` | `torrents.view` | — |
| `POST`   | `/api/categories` | `categories.manage` | `{ name (≤80), color?, savePath? }` |
| `DELETE` | `/api/categories/:id` | `categories.manage` | — |
| `GET`    | `/api/tags` | `torrents.view` | — |
| `POST`   | `/api/tags` | `tags.manage` | `{ name (≤80), color? }` |
| `DELETE` | `/api/tags/:id` | `tags.manage` | — |

---

## Files — `/api/files`

`@Controller('files')` guarded — tag `files`. All operations are confined to the
configured `FILE_MANAGER_ROOTS` allow-list via the `PathSafety` helper; paths
outside the roots, or names containing `/` or NUL, are rejected
(see [SECURITY.md](SECURITY.md#file-path-validation)).

| Method | Path | Permission | Body / Query |
|--------|------|------------|--------------|
| `GET`  | `/api/files` | `files.view` | `path` (query) — directory listing |
| `GET`  | `/api/files/properties` | `files.view` | `path` (query) — size, item count, ext, hash |
| `GET`  | `/api/files/preview` | `files.preview` | `path` (query) — UTF-8 text, ≤ 256 KB |
| `GET`  | `/api/files/download` | `files.download` | `path` (query) — streams the file (bearer required) |
| `POST` | `/api/files/folders` | `files.create_folder` | `{ path, name }` |
| `POST` | `/api/files/rename` | `files.rename` | `{ path, newName, overwrite? }` |
| `POST` | `/api/files/move` | `files.move` | `{ source, destination, overwrite? }` — `destination` is a directory |
| `POST` | `/api/files/copy` | `files.copy` | `{ source, destination, overwrite? }` — recursive for folders |
| `POST` | `/api/files/delete` | `files.delete` | `{ path, permanent? }` — soft-delete to Trash unless `permanent` |
| `POST` | `/api/files/bulk` | `files.bulk_actions` | `{ operation: 'move'\|'copy'\|'delete'\|'cleanup', paths[], destination?, overwrite?, permanent? }` |
| `POST` | `/api/files/cleanup-preview` | `files.cleanup` | `{ path, categories? }` → grouped candidates (read-only) |
| `POST` | `/api/files/cleanup-execute` | `files.cleanup` | `{ path, paths[], permanent? }` |
| `GET`  | `/api/files/trash` | `files.view` | — list trashed items |
| `POST` | `/api/files/trash/restore` | `files.delete` | `{ id, overwrite? }` |
| `POST` | `/api/files/trash/purge` | `files.delete` | `{ id }` — permanently remove one trashed item |
| `POST` | `/api/files/trash/empty` | `files.delete` | — empty the trash |

`GET /api/files` returns `{ path, roots, items[] }`, each item carrying `name`,
`path` (root-relative), `isDirectory`, `size`, and `modifiedAt` (directories
sorted first; the `.ultratorrent-trash` directory is hidden from listings).

**Trash mode (default delete):** `POST /api/files/delete` moves the item into a
`.ultratorrent-trash` directory inside its own storage root and records a
`TrashItem` row, so it can be restored to its original path or purged later.
Pass `permanent: true` to skip the trash and delete irreversibly. Deleting a
configured root, the filesystem root, or a system directory is always rejected.

**Cleanup Wizard:** `cleanup-preview` scans a folder and classifies candidates
(samples, empty folders, zero-byte/duplicate files, orphan subtitles/artwork,
NFO/SFV/TXT, hidden/temp, partial downloads) returning per-category groups with
item counts and recoverable bytes — it never touches disk. `cleanup-execute`
removes only the explicitly-selected candidate paths (to Trash by default).

Mutating operations emit `files.operation.{started,completed,failed}`,
`files.cleanup.completed`, and `files.trash.updated` over the `/ws` channel, and
write `file.*` audit rows (`created_folder`/`renamed`/`moved`/`copied`/`deleted`/
`cleanup_execute`/`restore`/`trash_empty`/`operation_failed`).

---

## RSS — `/api/rss`

`@Controller('rss')` guarded — tag `rss`. Enabled feeds are polled in the
background every 60 s; due feeds are fetched and items matching an enabled rule's
include/exclude regexes are auto-downloaded to the default engine (with
duplicate detection via `RssHistory`).

| Method | Path | Permission | Body |
|--------|------|------------|------|
| `GET`    | `/api/rss/feeds` | `rss.view` | — |
| `POST`   | `/api/rss/feeds` | `rss.manage` | `{ name, url, refreshInterval?, isEnabled? }` |
| `DELETE` | `/api/rss/feeds/:id` | `rss.manage` | — |
| `GET`    | `/api/rss/feeds/:id/history` | `rss.view` | — |
| `POST`   | `/api/rss/rules` | `rss.manage` | `{ feedId, name, includeRegex?, excludeRegex?, savePath?, autoDownload? }` |
| `DELETE` | `/api/rss/rules/:id` | `rss.manage` | — |

---

## Automation — `/api/automation`

`@Controller('automation')` guarded — tag `automation`. Rules are evaluated by
the `AutomationEngine` against trigger events fired by the sync loop — see
[ARCHITECTURE.md](ARCHITECTURE.md#real-time-sync-design). Triggers:
`torrent.completed` (edge-fired once when progress hits 100%) and `ratio.reached`
(re-checked each poll, edge-fired once when a torrent first satisfies a
ratio-based condition — pair with a `stop`/`delete` action to cap seeding).

| Method | Path | Permission | Body |
|--------|------|------------|------|
| `GET`    | `/api/automation/rules` | `automation.view` | — |
| `POST`   | `/api/automation/rules` | `automation.manage` | `UpsertRuleDto` |
| `PATCH`  | `/api/automation/rules/:id` | `automation.manage` | `UpsertRuleDto` |
| `DELETE` | `/api/automation/rules/:id` | `automation.manage` | — |
| `GET`    | `/api/automation/rules/:id/logs` | `automation.view` | — |

**`UpsertRuleDto`**:

```ts
{
  name: string;
  description?: string;
  trigger: string;                                 // "torrent.completed" | "ratio.reached"
  conditions: { field, op, value }[];              // op: eq|neq|gt|gte|lt|lte|contains|matches
  actions: { type, params? }[];                    // type: move|pause|stop|delete|delete_with_data|notify|webhook
  isEnabled?: boolean;
  priority?: number;                               // higher runs first
}
```

---

## Notifications — `/api/notifications`

`@Controller('notifications')` guarded by `JwtAuthGuard` only (any authenticated
user) — tag `notifications`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET`  | `/api/notifications` | Bearer | The current user's notifications (and broadcasts), newest first, max 100 |
| `POST` | `/api/notifications/:id/read` | Bearer | Mark a notification read |

Notifications are also pushed in real time over WebSocket (`notification` event)
and may be fanned out to external channels (webhook, Discord, Slack, Telegram)
configured under the `notifications.channels` setting.

---

## Settings — `/api/settings`

`@Controller('settings')` guarded — tag `settings`.

| Method | Path | Permission | Body |
|--------|------|------------|------|
| `GET` | `/api/settings` | `settings.view` | — |
| `PUT` | `/api/settings/:key` | `settings.manage` | `{ value: <any JSON> }` |

`GET` returns all settings as a `{ key: value }` map. `PUT` upserts a single key
and returns `{ key, value }`.

---

## Users & Roles — `/api/users`

`@Controller('users')` guarded — tag `users`.

| Method | Path | Permission | Body |
|--------|------|------------|------|
| `GET`    | `/api/users` | `users.view` | — |
| `GET`    | `/api/users/roles` | `users.view` | — |
| `POST`   | `/api/users` | `users.manage` | `CreateUserDto` |
| `PATCH`  | `/api/users/:id` | `users.manage` | `UpdateUserDto` |
| `DELETE` | `/api/users/:id` | `users.manage` | — |

**`CreateUserDto`**: `{ username, email, displayName?, password (≥10),
roleNames: string[] }`. **`UpdateUserDto`**: `{ email?, displayName?, isActive?,
roleNames? }` (replacing `roleNames` re-assigns roles). Passwords are hashed with
Argon2id. `GET /api/users/roles` returns roles with their permission sets. System
users cannot be deleted.

---

## API keys — `/api/api-keys`

`@Controller('api-keys')` guarded — tag `api-keys`. Keys belong to the calling
user.

| Method | Path | Permission | Body |
|--------|------|------------|------|
| `GET`    | `/api/api-keys` | `apikeys.manage` | — |
| `POST`   | `/api/api-keys` | `apikeys.manage` | `{ name, scopes?: string[] }` |
| `DELETE` | `/api/api-keys/:id` | `apikeys.manage` | — |

`POST` returns the **full key exactly once**: `{ prefix, key: "<prefix>.<secret>",
name }`. Only the Argon2id hash of the secret is stored. `GET` lists keys without
the secret; `DELETE` revokes (soft, sets `revokedAt`).

---

## Audit — `/api/audit`

`@Controller('audit')` guarded — tag `audit`.

| Method | Path | Permission | Query |
|--------|------|------------|-------|
| `GET` | `/api/audit` | `audit.view` | `page`, `pageSize` (cap 200, default 50), `action` |

Returns a paginated list of audit-log entries (newest first), each including the
acting username, `action`, `objectType`/`objectId`, `result`, `ipAddress`,
`userAgent`, `metadata`, and `createdAt`. Filter by exact `action`.

---

## Node Agent — `/api/node-agent`

`@Controller('node-agent')` (`NodeAgentController`) — tag `node-agent`. Every
install carries a persistent node identity and local agent; Central registration
requires the Enterprise overlay. See [NODE_AGENT.md](NODE_AGENT.md).

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `GET` | `/api/node-agent/status` | `node_agent.view` | Identity, Central status, local health snapshot, last heartbeat |
| `POST` | `/api/node-agent/register` | `node_agent.register` | Register with Central via the active transport. Body: `{ nodeName?, centralUrl?, enrollmentToken?, publicUrl? }`. Community returns `{ accepted:false, status:"unavailable", message }` |
| `POST` | `/api/node-agent/unregister` | `node_agent.unregister` | Disconnect from Central |
| `POST` | `/api/node-agent/heartbeat-now` | `node_agent.manage` | Collect + record a local heartbeat (and send if a transport is available) |
| `GET` | `/api/node-agent/events` | `node_agent.view` | Recent node-agent events (`?limit`, cap 500) |
| `GET` | `/api/node-agent/commands` | `node_agent.commands.view` | Recent remote commands (`?limit`, cap 200) |

Remote command types are restricted to an explicit allow-list; Core validates
and records them but never executes arbitrary shell commands (execution is an
Enterprise concern). WebSocket: `node_agent.status.updated`,
`node_agent.heartbeat.created`, `node_agent.registered`,
`node_agent.unregistered`, `node_agent.command.received/completed/failed`.

---

## Fleet Management — `/api/fleet`

`@Controller('fleet')` (`FleetController`, tag `fleet`) — **Enterprise overlay**.
The whole controller is `@RequiresModule('fleet_management')` + `ModuleGuard`, so
every route returns **403** unless the module is enabled, which requires a UPLM
entitlement. RBAC (`fleet.*`) is layered on top. See
[FLEET_MANAGEMENT.md](FLEET_MANAGEMENT.md).

| Method | Path | Permission |
|--------|------|------------|
| `GET` | `/api/fleet/overview` | `fleet.view` |
| `GET` | `/api/fleet/activity` | `fleet.view` |
| `GET` | `/api/fleet/alerts` | `fleet.view` |
| `GET` | `/api/fleet/search?q=` | `fleet.nodes.view` |
| `GET` | `/api/fleet/nodes` | `fleet.nodes.view` |
| `POST` | `/api/fleet/nodes` | `fleet.nodes.manage` (returns a one-time enrollment token) |
| `GET` | `/api/fleet/nodes/:id` | `fleet.nodes.view` |
| `PATCH` | `/api/fleet/nodes/:id` | `fleet.nodes.manage` |
| `DELETE` | `/api/fleet/nodes/:id` | `fleet.nodes.manage` |
| `POST` | `/api/fleet/nodes/:id/command` | `fleet.nodes.command` (approved types only; unknown → 400) |
| `GET` | `/api/fleet/nodes/:id/commands` | `fleet.nodes.view` |
| `GET` | `/api/fleet/nodes/:id/health` | `fleet.nodes.view` |
| `GET` | `/api/fleet/nodes/:id/audit` | `fleet.nodes.audit` |
| `GET` | `/api/fleet/nodes/:id/modules` | `fleet.nodes.view` |
| `GET` | `/api/fleet/groups` | `fleet.view` |
| `POST`/`PATCH`/`DELETE` | `/api/fleet/groups[/:id]` | `fleet.manage` |
| `GET` | `/api/fleet/policies` | `fleet.policies.view` |
| `POST`/`PATCH`/`DELETE` | `/api/fleet/policies[/:id]` | `fleet.policies.manage` |
| `POST` | `/api/fleet/policies/:id/apply` | `fleet.policies.manage` |
| `POST` | `/api/fleet/enroll` · `/api/fleet/heartbeat` | node token (scaffold transport boundary; not user-authed) |

WebSocket: `fleet.node.registered/online/offline`, `fleet.node.health.updated`,
`fleet.node.command.started/completed/failed`, `fleet.alert.created`.

---

## Customer Management — `/api/customers`

`@Controller('customers')` (`CustomersController`) — **Enterprise overlay**,
`@RequiresModule('customers')` + `ModuleGuard` (UPLM) + RBAC. See
[FLEET_MANAGEMENT.md](FLEET_MANAGEMENT.md) for node ownership.

| Method | Path | Permission |
|--------|------|------------|
| `GET` | `/api/customers?status=` | `customers.view` |
| `POST` | `/api/customers` | `customers.manage` |
| `GET`/`PATCH`/`DELETE` | `/api/customers/:id` | view / manage / manage |
| `GET` | `/api/customers/:id/nodes` | `customers.view` |
| `POST` | `/api/customers/:id/nodes/:nodeId/assign` | `customers.assign_nodes` |
| `DELETE` | `/api/customers/:id/nodes/:nodeId` | `customers.assign_nodes` |
| `GET` | `/api/customers/:id/services` | `customers.view` |
| `POST` | `/api/customers/:id/services` | `customers.manage` |
| `PATCH` | `/api/customers/:id/services/:serviceId` | `customers.manage` |

Node assignment validates the node against the fleet registry and mirrors
`customerId` onto the `FleetNode`.

---

## Provisioning — `/api/provisioning`

`@Controller('provisioning')` (`ProvisioningController`) — **Enterprise
overlay**, module-gated + RBAC. Cloud-agnostic (Vultr scaffold). See
[PROVISIONING.md](PROVISIONING.md).

| Method | Path | Permission |
|--------|------|------------|
| `GET` | `/api/provisioning/providers` · `/providers/:p/regions` · `/providers/:p/plans` | `provisioning.view` |
| `POST` | `/api/provisioning/providers/:p/test` | `provisioning.manage` |
| `GET` | `/api/provisioning/credentials` | `provisioning.view` (masked; secrets encrypted at rest) |
| `POST`/`DELETE` | `/api/provisioning/credentials[/:id]` | `provisioning.manage` |
| `GET`/`POST`/`PATCH` | `/api/provisioning/plans[/:id]` | view / manage / manage |
| `GET` | `/api/provisioning/jobs` · `/jobs/:id` | `provisioning.view` |
| `POST` | `/api/provisioning/jobs` | `provisioning.create_server` |
| `POST` | `/api/provisioning/jobs/:id/cancel` | `provisioning.manage` |

---

## Billing — `/api/billing`

`@Controller('billing')` (`BillingController`) — **Enterprise overlay**,
module-gated + RBAC. Provider-agnostic (Manual default). See
[BILLING.md](BILLING.md).

| Method | Path | Permission |
|--------|------|------------|
| `GET` | `/api/billing/providers` · `/configs` · `/events` | `billing.view` |
| `POST`/`DELETE` | `/api/billing/configs[/:id]` | `billing.manage` (secrets encrypted at rest) |
| `POST` | `/api/billing/customers` · `/subscriptions` | `billing.manage` |
| `POST` | `/api/billing/services/:id/suspend` | `billing.suspend` (audited) |
| `POST` | `/api/billing/services/:id/resume` | `billing.resume` (audited) |
| `POST` | `/api/billing/webhook/:provider` | provider signature (module-gated; not user-authed) |

---

## Premium modules (Milestone 6)

All are **premium Enterprise overlays**, each `@RequiresModule(<id>)` +
`ModuleGuard` (UPLM) + RBAC. See [MEDIA_RENAMER.md](MEDIA_RENAMER.md),
[MULTI_SERVER.md](MULTI_SERVER.md), [MEDIA_SERVERS.md](MEDIA_SERVERS.md),
[ANALYTICS.md](ANALYTICS.md).

### Media Renamer — `/api/media-renamer` (module `media_renamer_pro`)

| Method | Path | Permission |
|--------|------|------------|
| `POST` | `/analyze` | `media_renamer.view` |
| `POST` | `/dry-run` | `media_renamer.preview` |
| `POST` | `/execute` | `media_renamer.execute` |
| `GET` | `/jobs` · `/jobs/:id` | `media_renamer.view` |
| `POST` | `/jobs/:id/rollback` | `media_renamer.rollback` |
| `GET` | `/templates` | `media_renamer.view` |
| `POST`/`PATCH`/`DELETE` | `/templates[/:id]` | `media_renamer.manage_templates` |

### Release Scoring — `/api/release-scoring` (module `release_scoring`)

| Method | Path | Permission |
|--------|------|------------|
| `POST` | `/score` · `/test-rule` | `release_scoring.view` |

Returns `{ score (0–100), decision, reasons[], warnings[], parsed }`.

### Analytics — `/api/analytics` (module `advanced_analytics`)

| Method | Path | Permission |
|--------|------|------------|
| `GET` | `/overview?days=` | `analytics.view` |

### Multi-Server — `/api/multi-server` (module `multi_server`)

| Method | Path | Permission |
|--------|------|------------|
| `GET` | `/overview` · `/best-engine` | `multi_server.view` |
| `GET`/`POST`/`PATCH`/`DELETE` | `/groups[/:id]` | view / manage |
| `GET`/`POST`/`DELETE` | `/engines/:engineId/storage[/:id]` | view / manage |

### Media Servers — `/api/media-servers` (module `library_awareness`)

| Method | Path | Permission |
|--------|------|------------|
| `GET` | `/servers` · `/servers/:id/libraries` | `media_servers.view` |
| `POST` | `/servers/:id/find` · `/servers/:id/missing` | `media_servers.view` |
| `POST`/`DELETE` | `/servers[/:id]` | `media_servers.manage` (settings encrypted at rest) |
| `POST` | `/servers/:id/scan/:libraryId` | `media_servers.manage` |

### Media Acquisition Intelligence — `/api/media-acquisition` (module `media_acquisition_intelligence`)

Decides what to acquire; explainable decisions; **never performs file
operations**. See [MEDIA_ACQUISITION_INTELLIGENCE.md](MEDIA_ACQUISITION_INTELLIGENCE.md).

| Method | Path | Permission |
|--------|------|------------|
| `GET` | `/overview` · `/evaluations[/:id]` · `/approval-queue` · `/recommendations` | `media_acquisition.view` |
| `GET` | `/watchlist[/:id]` · `/profiles[/:id]` | `media_acquisition.view` |
| `POST`/`PATCH`/`DELETE` | `/watchlist[/:id]` | `media_acquisition.manage_watchlist` |
| `POST`/`PATCH`/`DELETE` | `/profiles[/:id]` | `media_acquisition.manage_profiles` |
| `POST` | `/evaluate` | `media_acquisition.evaluate` |
| `POST` | `/evaluations/:id/approve` · `/reject` · `/override` | `…approve` / `…reject` / `…override` |
| `GET` | `/history` | `media_acquisition.history` |
| `GET`/`PATCH` | `/settings` | `media_acquisition.settings` |
| `POST` | `/export` | `media_acquisition.export` |

---

## System — `/api/system`

`@Controller('system')` (`SystemController`) — tag `system`.

| Method | Path | Auth | Permission | Description |
|--------|------|------|------------|-------------|
| `GET` | `/api/system/live` | **Public** | — | Liveness: `{ status: "ok", uptime }` |
| `GET` | `/api/system/ready` | **Public** | — | Readiness: `{ status, database }` (DB ping) |
| `GET` | `/api/system/version` | **Public** | — | `{ product, version, edition, apiVersion, gitSha, buildTime, node }` — product/edition (community\|enterprise) version |
| `GET` | `/api/system/health` | Bearer | `system.view` | Detailed: process info, per-engine health, and disk usage for each file-manager root |

The public `live`/`ready` probes are designed for container/orchestrator health
checks (the backend Docker image probes `/api/system/live`).

---

## WebSocket API

Real-time updates are delivered over Socket.IO at **`/ws`**. Authenticate by
passing the JWT access token in the handshake:

```ts
import { io } from 'socket.io-client';

const socket = io('/', { path: '/ws', auth: { token: accessToken } });
// also accepted: ?token=<accessToken> in the handshake query
```

On a valid token the client joins a shared `broadcast` room and a private
`user:<id>` room; an invalid token disconnects the socket. Events
(`packages/shared/src/events.ts`):

| Event (`WS_EVENTS`) | Payload | Emitted when |
|---------------------|---------|--------------|
| `torrents:update` (`TORRENTS_UPDATE`) | `{ engineId, torrents: NormalizedTorrent[], at }` | Each sync tick (~2 s) |
| `stats:update` (`STATS_UPDATE`) | `{ engineId, stats: GlobalStats, at }` | Each sync tick |
| `engine:status` (`ENGINE_STATUS`) | `{ engineId, online, error, at }` | Each sync tick / on engine failure |
| `notification` (`NOTIFICATION`) | `{ id, level, title, message, createdAt }` | On dispatch (broadcast or per-user) |
| `torrent:update` / `system:health` | — | Reserved |

---

## Not yet exposed

The MVP now exposes the large majority of the data model over HTTP. A few items
remain modeled in the schema without a dedicated endpoint: **download paths**
(`DownloadPath`) and **system events** (`SystemEvent`) have no controller yet, and
**API-key authentication** is issuable/revocable but is not yet accepted as an
alternative credential on requests (all routes authenticate via JWT). The
`torrents.rename` permission and the provider's `renameTorrent`/`renameFile`
capabilities also have no dedicated REST route yet.
</content>
