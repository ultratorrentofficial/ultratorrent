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
- [Indexers — `/api/indexers`](#indexers--apiindexers)
- [Prowlarr integration — `/api/integrations/prowlarr`](#prowlarr-integration--apiintegrationsprowlarr)
- [Media Server Analytics — `/api/media-server-analytics`](#media-server-analytics--apimedia-server-analytics)
- [Settings — `/api/settings`](#settings--apisettings)
- [Account — `/api/account`](#account--apiaccount)
- [Users & Roles — `/api/users`](#users--roles--apiusers)
- [API keys — `/api/api-keys`](#api-keys--apiapi-keys)
- [Audit — `/api/audit`](#audit--apiaudit)
- [Media Manager — `/api/media`](#media-manager--apimedia)
- [Media Acquisition Intelligence — `/api/media-acquisition`](#media-acquisition-intelligence--apimedia-acquisition)
- [Release Scoring — `/api/release-scoring`](#release-scoring--apirelease-scoring)
- [Modules — `/api/modules`](#modules--apimodules)
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
| `GET` | `/api/torrents/:hash/matched-rule` | `torrents.view` | — (the RSS rule, if any, that added the torrent) |
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
`removeData`. Returns `{ succeeded, failed }` counts.

The route decorator only declares `torrents.view`, but that is **not** the whole
gate: `TorrentsService.bulk` then enforces the **same permission as the action's
dedicated single-torrent route** before executing anything
(`BULK_ACTION_PERMISSIONS` — `remove` → `torrents.delete`, `removeData` →
`torrents.delete_data`, `start` → `torrents.start`, …). A caller missing it gets
`403 Missing permission: <key>` and an audited `torrents.bulk.<action>` failure
row. A viewer therefore cannot bulk-delete.

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
| `POST`   | `/api/engines/test` | `engines.manage` | `TestEngineDto` — probe a connection without persisting it |
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

> `kind: "rtorrent"` and `kind: "qbittorrent"` are implemented today.
> `transmission` and `deluge` pass DTO validation, but the provider factory throws
> "planned but not yet implemented" — the UI disables them.

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
| `GET`  | `/api/files/root` | `files.view` | — the configured Default Root Path and allow-list roots |
| `PUT`  | `/api/files/root` | `settings.manage_root_path` | `{ path }` — change the Default Root Path (validated, narrowed to `FILE_MANAGER_ROOTS`, audited) |
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

### Feeds

| Method | Path | Permission | Body / Query |
|--------|------|------------|--------------|
| `GET`    | `/api/rss/feeds` | `rss.view` | — |
| `POST`   | `/api/rss/feeds` | `rss.manage` | `CreateFeedDto` — `{ name, url, refreshInterval?, isEnabled? }` |
| `PATCH`  | `/api/rss/feeds/:id` | `rss.manage` | `UpdateFeedDto` (all fields optional) |
| `DELETE` | `/api/rss/feeds/:id` | `rss.manage` | — |
| `GET`    | `/api/rss/feeds/:id/history` | `rss.view` | `page`, `pageSize` (default 25) |
| `POST`   | `/api/rss/feeds/:id/refresh` | `rss.manage` | — fetch the feed now |

### Rules

| Method | Path | Permission | Body |
|--------|------|------------|------|
| `POST`   | `/api/rss/rules` | `rss.manage` | `CreateRuleDto` — `{ feedId, name, includeRegex?, excludeRegex?, savePath?, autoDownload?, mediaType?, showStatusProvider?, showStatusProviderId?, allowInactiveShowMonitoring? }` |
| `PATCH`  | `/api/rss/rules/:id` | `rss.manage` | `UpdateRuleDto` (all fields optional) |
| `DELETE` | `/api/rss/rules/:id` | `rss.manage` | — |

For a TV rule (`mediaType ∈ tv/anime/episode/series`) whose resolved show is **ended/canceled**, the save returns `400` unless `allowInactiveShowMonitoring: true` is passed (the override is audited). Unknown status saves with a stored warning; active shows save normally. The resolved airing-status snapshot is persisted on the rule.

### TV show airing status

| Method | Path | Permission | Body / Query |
|--------|------|------------|------|
| `GET`  | `/api/rss/show-status/lookup` | `rss.show_status.lookup` | `?title=&year=&provider=` → `ShowStatusResult` (`normalizedStatus`, `recommendation`, `confidence`, first/last/next-episode dates, `posterUrl`, `warnings`, …) |
| `POST` | `/api/rss/show-status/lookup-batch` | `rss.show_status.lookup` | `{ queries: [{ title, year? }] }` → `ShowStatusResult[]` |
| `GET`    | `/api/rss/rules-export` | `rss.view` | — export all rules (and their match filters) |
| `POST`   | `/api/rss/rules-import` | `rss.manage` | previously-exported rules payload |
| `GET`    | `/api/rss/rules/:id/match-history` | `rss.view` | — items this rule has matched |

### Match candidates (preference list)

| Method | Path | Permission | Body |
|--------|------|------------|------|
| `GET`    | `/api/rss/rules/:id/match-candidates` | `rss.view` | — |
| `POST`   | `/api/rss/rules/:id/match-candidates` | `rss.manage` | candidate spec |
| `POST`   | `/api/rss/rules/:id/match-candidates/reorder` | `rss.manage` | `{ orderedIds: string[] }` |
| `PATCH`  | `/api/rss/rules/:id/match-candidates/:candidateId` | `rss.manage` | candidate patch |
| `DELETE` | `/api/rss/rules/:id/match-candidates/:candidateId` | `rss.manage` | — |

### Testing, backfill & Smart Match

| Method | Path | Permission | Body |
|--------|------|------------|------|
| `POST` | `/api/rss/rules/:id/test-match` | `rss.view` | test a candidate string against the rule |
| `POST` | `/api/rss/rules/:id/test-preference-list` | `rss.view` | test the ordered preference list |
| `POST` | `/api/rss/rules/:id/test-history` | `rss.view` | re-test the rule against stored feed history |
| `POST` | `/api/rss/rules/:id/backfill` | `rss.manage` | replay history through the rule |
| `POST` | `/api/rss/history/:id/download` | `rss.manage` | download a specific history item |
| `POST` | `/api/rss/convert-to-regex` | `rss.view` | `{ text }` → `{ pattern }` |
| `POST` | `/api/rss/smart-match/analyze` | `rss.view` | `{ torrentName }` — analyze into match components |
| `POST` | `/api/rss/smart-match/test` | `rss.view` | test a smart-match spec |
| `POST` | `/api/rss/rules/:id/apply-smart-match` | `rss.manage` | apply a smart-match spec to the rule |

---

## Automation — `/api/automation`

`@Controller('automation')` guarded — tag `automation`. Rules are evaluated by
the `AutomationEngine` against trigger events fired by the sync loop and by the
media/RSS subsystems — see
[ARCHITECTURE.md](ARCHITECTURE.md#real-time-sync-design).

| Method | Path | Permission | Body |
|--------|------|------------|------|
| `GET`    | `/api/automation/catalog` | `automation.view` | — the authoritative trigger + action catalog |
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
  trigger: string;                                 // a trigger id — see the catalog
  conditions: { field, op, value }[];              // op: eq|neq|gt|gte|lt|lte|contains|matches
  actions: { type, params? }[];                    // an action id — see the catalog
  isEnabled?: boolean;
  priority?: number;                               // higher runs first
}
```

**Triggers and actions.** `trigger` and `action.type` are validated as free
strings by the DTO; the registered ids live in `AUTOMATION_TRIGGERS` /
`AUTOMATION_ACTIONS` (`modules/automation/automation.module.ts`) and are served
by `GET /api/automation/catalog` — treat that route, not this doc, as the source
of truth. There are **14** triggers in three categories:

- **torrent** — `torrent.completed` (edge-fired once when progress hits 100%) and
  `ratio.reached` (re-checked each poll, edge-fired once when a torrent first
  satisfies a ratio-based condition — pair with a `stop`/`delete` action to cap
  seeding).
- **media** — `media.detected`, `media.matched`, `media.unmatched`,
  `media.missing_artwork`, `media.missing_subtitles`, `media.rename_completed`,
  `media.server_refresh_failed`.
- **rss** — `rss.rule.created_for_inactive_show`, `rss.show_status.changed`,
  `rss.show.became_active`, `rss.show.ended`, `rss.show.canceled`.

Actions likewise span torrent (`move`, `pause`, `stop`, `delete`,
`delete_with_data`, `notify`, `webhook`), notification (`send_notification`),
media (`rename_for_media`, `media_scan_library`, `media_match`,
`media_fetch_metadata`, `media_fetch_artwork`, `media_generate_nfo`,
`media_rename`, `media_move`, `media_notify`, `media_server_refresh`) and rss
(`refresh_rss_show_status`, `disable_rss_rule`, `convert_rule_to_backfill`,
`notify_admin`) categories.

> The **Automation Rules UI currently only offers the two torrent triggers**
> (`torrent.completed`, `ratio.reached`); the remaining triggers and the media/rss
> actions are reachable over the API but have no picker in the frontend yet.

---

## Notifications — `/api/notifications`

Two controllers share the `/api/notifications` prefix.

### In-app inbox

`NotificationsController` (`modules/notifications`), guarded by `JwtAuthGuard`
only (any authenticated user) — tag `notifications`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET`  | `/api/notifications` | Bearer | The current user's notifications (and broadcasts), newest first, max 100 |
| `POST` | `/api/notifications/:id/read` | Bearer | Mark a notification read |

These are pushed in real time over WebSocket (the permission-free `notification`
event, delivered to every authenticated socket).

### Notification Center

`NotificationCenterController` (`modules/notification-center`), guarded by
`JwtAuthGuard` + `PermissionsGuard`. This is the delivery subsystem — channels,
recipients, groups, templates, rules, queue and delivery history. Every route
below is `RequirePermissions`-gated with a `notifications.*` permission.

| Method | Path | Permission |
|--------|------|------------|
| `GET`    | `/api/notifications/dashboard` | `notifications.view` |
| `GET`    | `/api/notifications/providers` | `notifications.view` |
| `GET`    | `/api/notifications/channels` · `/channels/:id` | `notifications.view` |
| `POST`   | `/api/notifications/channels` | `notifications.manage_channels` |
| `PATCH`  | `/api/notifications/channels/:id` | `notifications.manage_channels` |
| `DELETE` | `/api/notifications/channels/:id` | `notifications.manage_channels` |
| `POST`   | `/api/notifications/channels/:id/test` | `notifications.send_test` |
| `GET`    | `/api/notifications/recipients` | `notifications.view` |
| `POST`   | `/api/notifications/recipients` | `notifications.manage_recipients` |
| `PATCH`  | `/api/notifications/recipients/:id` | `notifications.manage_recipients` |
| `DELETE` | `/api/notifications/recipients/:id` | `notifications.manage_recipients` |
| `GET`    | `/api/notifications/groups` | `notifications.view` |
| `POST`   | `/api/notifications/groups` | `notifications.manage_groups` |
| `DELETE` | `/api/notifications/groups/:id` | `notifications.manage_groups` |
| `PUT`    | `/api/notifications/groups/:id/members` | `notifications.manage_groups` |
| `GET`    | `/api/notifications/templates` | `notifications.view` |
| `POST`   | `/api/notifications/templates` | `notifications.manage_templates` |
| `PATCH`  | `/api/notifications/templates/:id` | `notifications.manage_templates` |
| `DELETE` | `/api/notifications/templates/:id` | `notifications.manage_templates` |
| `POST`   | `/api/notifications/templates/preview` | `notifications.manage_templates` |
| `GET`    | `/api/notifications/rules` · `/rules/:id` | `notifications.view` |
| `POST`   | `/api/notifications/rules` | `notifications.manage_rules` |
| `PATCH`  | `/api/notifications/rules/:id` | `notifications.manage_rules` |
| `DELETE` | `/api/notifications/rules/:id` | `notifications.manage_rules` |
| `GET`    | `/api/notifications/history` · `/queue` | `notifications.view_history` |
| `POST`   | `/api/notifications/history/:id/retry` | `notifications.retry` |
| `GET`    | `/api/notifications/preferences/:recipientId` | `notifications.view` |
| `PUT`    | `/api/notifications/preferences` | `notifications.manage_preferences` |
| `GET`    | `/api/notifications/settings` | `notifications.manage_settings` |
| `PATCH`  | `/api/notifications/settings` | `notifications.manage_settings` |
| `POST`   | `/api/notifications/test` | `notifications.send_test` |

Modules stay decoupled from the Center: they publish a `DomainEventEnvelope` onto
the single internal bus channel (`NOTIFICATION_BUS_CHANNEL`) using a name from
`NOTIFICATION_EVENTS` (`packages/shared/src/events.ts`), and the Center is the
sole subscriber — it evaluates rules and fans out to the configured channels.

---

## Indexers — `/api/indexers`

`@Controller('indexers')` (`IndexersController`) guarded by `JwtAuthGuard` +
`PermissionsGuard`. Torznab/Newznab indexer definitions and active search.

> Indexers are **not** a module-registry module — there is no `indexers` manifest
> and no module toggle. They are an always-present, purely RBAC-gated subsystem.

| Method | Path | Permission |
|--------|------|------------|
| `GET`    | `/api/indexers` · `/api/indexers/:id` | `indexers.view` |
| `POST`   | `/api/indexers` | `indexers.manage` |
| `PATCH`  | `/api/indexers/:id` | `indexers.manage` |
| `DELETE` | `/api/indexers/:id` | `indexers.manage` |
| `POST`   | `/api/indexers/:id/test` | `indexers.test` |
| `GET`    | `/api/indexers/:id/search` | `indexers.test` |

Indexer API keys are AES-256-GCM encrypted at rest and redacted on read — see
[SECURITY.md](SECURITY.md#secrets-management).

---

## Prowlarr integration — `/api/integrations/prowlarr`

`@Controller('integrations/prowlarr')` (`ProwlarrController`) guarded by
`JwtAuthGuard` + `PermissionsGuard`. Like Indexers, this is an RBAC-gated
subsystem rather than a registry module. See [PROWLARR.md](PROWLARR.md).

| Method | Path | Permission |
|--------|------|------------|
| `GET`   | `/api/integrations/prowlarr` | `integrations.prowlarr.view` — settings (API key redacted) |
| `PATCH` | `/api/integrations/prowlarr` | `integrations.prowlarr.manage` |
| `POST`  | `/api/integrations/prowlarr/test` | `integrations.prowlarr.test` |
| `GET`   | `/api/integrations/prowlarr/status` | `integrations.prowlarr.view` — health probe |
| `POST`  | `/api/integrations/prowlarr/open` | `integrations.prowlarr.open` — resolve the public URL for the nav's external link |

---

## Media Server Analytics — `/api/media-server-analytics`

`@Controller('media-server-analytics')` (`MediaServerAnalyticsController`) guarded
by `JwtAuthGuard` + `PermissionsGuard`. Plex/Jellyfin/Emby watch analytics: server
connections, live activity, watch history, reports, importers and newsletters.
Every route is gated by a `media_server_analytics.*` permission.

| Method | Path | Permission |
|--------|------|------------|
| `GET`  | `/api/media-server-analytics/dashboard` | `media_server_analytics.view` |
| `GET`  | `/api/media-server-analytics/live` · `/live/:id/artwork` | `media_server_analytics.view_live_activity` |
| `POST` | `/api/media-server-analytics/live/poll` | `media_server_analytics.manage_connections` |
| `GET`  | `/api/media-server-analytics/watch-history` | `media_server_analytics.view_history` |
| `GET`  | `/api/media-server-analytics/reports/{usage,users,libraries,playback,top-media,devices,heatmap,trends,resolutions,library-growth,bandwidth}` | `media_server_analytics.view_reports` |
| `GET`  | `/api/media-server-analytics/export/watch-history` | `media_server_analytics.export` |
| `GET`  | `/api/media-server-analytics/meta/libraries` · `/meta/users` | `media_server_analytics.view` |
| `GET`  | `/api/media-server-analytics/meta/sync-runs` | `media_server_analytics.view_reports` |
| `POST` | `/api/media-server-analytics/meta/sync` | `media_server_analytics.manage_connections` |
| `GET`  | `/api/media-server-analytics/users` | `media_server_analytics.view_users` |
| `GET`  | `/api/media-server-analytics/recently-added` | `media_server_analytics.view` |
| `GET`·`POST`·`PATCH`·`DELETE` | `/api/media-server-analytics/import-sources[/:id]`, `/:id/test`, `/:id/preview`, `/import-jobs[/:id]` | `media_server_analytics.manage_imports` |
| `POST` | `/api/media-server-analytics/import-sources/:id/import` | `media_server_analytics.run_imports` |
| `GET`·`POST`·`PATCH`·`DELETE` | `/api/media-server-analytics/newsletters[/:id]`, `/:id/preview`, `/:id/deliveries` | `media_server_analytics.manage_newsletters` |
| `POST` | `/api/media-server-analytics/newsletters/:id/test-send` · `/send-now` | `media_server_analytics.send_newsletters` |
| `GET`·`PATCH` | `/api/media-server-analytics/settings/email` · `/settings/newsletter-images` | `media_server_analytics.manage_settings` |
| `POST` | `/api/media-server-analytics/settings/email/test` | `media_server_analytics.manage_settings` |
| `GET`  | `/api/media-server-analytics/connections[/:id]` · `/connections/:id/libraries` | `media_server_analytics.view` |
| `POST`·`PATCH`·`DELETE` | `/api/media-server-analytics/connections[/:id]`, `/:id/test`, `/:id/sync` | `media_server_analytics.manage_connections` |

**One deliberately public route.** `GET /api/media-server-analytics/nl-image/:id?e=&s=`
(`NewsletterImageController`) carries **no auth guard** — mail clients and Gmail's
image proxy cannot send a bearer token. It is instead gated by a per-image,
HMAC-signed, expiring token (`e`/`s`), serves only a downscaled `MediaArtwork` row
by id (never an arbitrary file or library path), and returns `404` — not `403` —
on a bad or expired token so it reveals nothing.

---

## Settings — `/api/settings`

`@Controller('settings')` guarded — tag `settings`.

| Method | Path | Permission | Body |
|--------|------|------------|------|
| `GET`   | `/api/settings` | `settings.view` | — |
| `PUT`   | `/api/settings/:key` | `settings.manage` | `{ value: <any JSON> }` |
| `PATCH` | `/api/settings` | `settings.manage` | `{ "<key>": <value>, … }` — bulk upsert |

`GET` returns all settings as a `{ key: value }` map. `PUT` upserts a single key
and returns `{ key, value }`. `PATCH` upserts every key in the body and returns
the full settings map. A protected set of keys cannot be written through these
routes.

---

## Account — `/api/account`

`@Controller('account')` guarded by `JwtAuthGuard` only (any authenticated user
manages their own account) — tag `account`.

| Method | Path | Auth | Body |
|--------|------|------|------|
| `GET`   | `/api/account/profile` | Bearer | — current user's profile |
| `PATCH` | `/api/account/profile` | Bearer | `UpdateProfileDto` (e.g. `displayName`, `email`) |
| `POST`  | `/api/account/password` | Bearer | `{ currentPassword, newPassword }` |
| `GET`   | `/api/account/2fa` | Bearer | — TOTP status for the current user |
| `POST`  | `/api/account/2fa/setup` | Bearer | — begin enrollment (returns secret + otpauth URL) |
| `POST`  | `/api/account/2fa/enable` | Bearer | `{ code }` — verify and enable |
| `POST`  | `/api/account/2fa/disable` | Bearer | `{ password }` |
| `POST`  | `/api/account/2fa/recovery` | Bearer | `{ code }` — regenerate recovery codes |

Changing the password (via `/api/account/password`) revokes the user's existing
refresh tokens. Enabling/disabling 2FA and password changes write `account.*`
audit rows.

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

> **An API key cannot currently authenticate a request.** These three routes only
> *mint, list and revoke* key records — nothing consumes them. No guard, Passport
> strategy or middleware ever reads `ApiKey.keyHash`: the only authentication path
> is `JwtStrategy`, which extracts a **bearer JWT** and nothing else. Presenting a
> `ut_….<secret>` key on any endpoint yields `401`.
>
> Consequently the stored `scopes` are **never enforced**, and `lastUsedAt` /
> `expiresAt` are **never written or checked** — `scopes` and `lastUsedAt` are
> merely echoed back by `GET /api/api-keys`. Treat this module as a
> not-yet-wired-up placeholder, not as a credential mechanism, and do not model
> access control around it. All programmatic access must use the JWT flow above.

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

## Media Manager — `/api/media`

`@Controller('media')` (`MediaController`) guarded by `JwtAuthGuard` +
`PermissionsGuard` — tag `media`. The Media Manager organizes a media library:
scanning, metadata/artwork/subtitle enrichment, NFO generation, duplicate
detection, media-server integrations, and a rename engine. See
[MEDIA_MANAGER.md](MEDIA_MANAGER.md).

### Overview & libraries

| Method | Path | Permission |
|--------|------|------------|
| `GET`    | `/api/media/dashboard` | `media_manager.view` |
| `GET`    | `/api/media/health` | `media_manager.view` |
| `GET`    | `/api/media/libraries` | `media_manager.view` |
| `POST`   | `/api/media/libraries` | `media_manager.manage_libraries` |
| `PATCH`  | `/api/media/libraries/:id` | `media_manager.manage_libraries` |
| `DELETE` | `/api/media/libraries/:id` | `media_manager.manage_libraries` |
| `POST`   | `/api/media/libraries/:id/scan` | `media_manager.scan` |

### Items, matching & metadata

| Method | Path | Permission |
|--------|------|------------|
| `GET`   | `/api/media/items` | `media_manager.view` (`?mediaType`, `?matchStatus`, `?libraryId`) |
| `GET`   | `/api/media/items/:id` | `media_manager.view` |
| `PATCH` | `/api/media/items/:id` | `media_manager.edit_metadata` |
| `POST`  | `/api/media/items/:id/match` | `media_manager.match` (empty body re-runs auto-identify; a body matches manually) |
| `POST`  | `/api/media/items/:id/unmatch` | `media_manager.match` |
| `POST`  | `/api/media/items/:id/metadata/fetch` | `media_manager.edit_metadata` |
| `PATCH` | `/api/media/items/:id/metadata` | `media_manager.edit_metadata` |

### Artwork & subtitles

| Method | Path | Permission |
|--------|------|------------|
| `GET`  | `/api/media/items/:id/artwork` | `media_manager.view` |
| `POST` | `/api/media/items/:id/artwork/select` | `media_manager.manage_artwork` (`{ artworkId }`) |
| `POST` | `/api/media/items/:id/artwork/upload` | `media_manager.manage_artwork` |
| `GET`  | `/api/media/items/:id/artwork/missing` | `media_manager.view` |
| `GET`  | `/api/media/items/:id/subtitles` | `media_manager.view` |
| `POST` | `/api/media/items/:id/subtitles/scan` | `media_manager.manage_subtitles` |
| `GET`  | `/api/media/items/:id/subtitles/missing` | `media_manager.view` (`?preferred=en,fr`) |

### NFO, duplicates & server integrations

| Method | Path | Permission |
|--------|------|------------|
| `POST`   | `/api/media/nfo/generate` | `media_manager.generate_nfo` (`{ itemId? , libraryId? }`) |
| `GET`    | `/api/media/duplicates` | `media_manager.view` |
| `POST`   | `/api/media/duplicates/detect` | `media_manager.view` |
| `GET`    | `/api/media/server-integrations` | `media_manager.manage_integrations` |
| `POST`   | `/api/media/server-integrations` | `media_manager.manage_integrations` (settings encrypted at rest) |
| `PATCH`  | `/api/media/server-integrations/:id` | `media_manager.manage_integrations` |
| `DELETE` | `/api/media/server-integrations/:id` | `media_manager.manage_integrations` |
| `POST`   | `/api/media/server-integrations/:id/test` | `media_manager.manage_integrations` |
| `POST`   | `/api/media/server-integrations/:id/refresh` | `media_manager.manage_integrations` |

Media-server integration (Plex/Jellyfin/Emby-style connectors) lives here under
`/api/media/server-integrations` — there is no separate `/api/media-servers`
group.

### Rename engine

| Method | Path | Permission |
|--------|------|------------|
| `GET`  | `/api/media/presets` | `media_manager.view` |
| `POST` | `/api/media/preview` | `media_manager.view` — build a rename plan (dry-run) |
| `POST` | `/api/media/apply` | `media_manager.rename` — execute the plan |
| `GET`  | `/api/media/history` | `media_manager.view` |

### IMDb provider — `/api/media/providers/imdb`

Compliant IMDb metadata provider. Data comes **only** from user-provided IMDb
datasets and/or an optional licensed IMDb REST API — UltraTorrent does not scrape
IMDb web pages. The licensed API key is AES-GCM encrypted at rest and redacted in
responses; dataset paths are confined to `FILE_MANAGER_ROOTS`.

| Method | Path | Permission |
|--------|------|------------|
| `GET`   | `/api/media/providers/imdb/status` | `media_manager.imdb.view` — mode, health, dataset title count, last import |
| `GET`   | `/api/media/providers/imdb/settings` | `media_manager.imdb.view` — redacted (`hasApiKey`, no secret) |
| `PATCH` | `/api/media/providers/imdb/settings` | `media_manager.imdb.configure` (`{ mode?, apiBaseUrl?, apiKey?, datasetPath?, importSchedule?, preferredRegion?, preferredLanguage?, includeAdult?, minVotes?, cacheTtl? }`) |
| `POST`  | `/api/media/providers/imdb/test` | `media_manager.imdb.configure` — test the licensed API connection |
| `POST`  | `/api/media/providers/imdb/dataset/validate` | `media_manager.imdb.import_dataset` (`{ datasetPath }`) — check files exist, are in-root, valid gzip/TSV |
| `POST`  | `/api/media/providers/imdb/dataset/import` | `media_manager.imdb.import_dataset` (`{ datasetPath }`) — returns the import record; runs as a detached job |
| `GET`   | `/api/media/providers/imdb/dataset/imports` | `media_manager.imdb.view` — import history |
| `GET`   | `/api/media/providers/imdb/search` | `media_manager.imdb.search` (`?title`, `?year`, `?type`, `?season`, `?episode`; throttled 30/min) |
| `GET`   | `/api/media/providers/imdb/title/:imdbId` | `media_manager.imdb.view` — single title by IMDb id |
| `POST`  | `/api/media/items/:id/match/imdb` | `media_manager.imdb.match` (`{ imdbId, confidence? }`) — store IMDb id as an external id |

Provider modes (`mode`): `disabled` (default), `dataset` (imported tables only),
`official_api` (licensed API only), `hybrid` (dataset first, API fallback).
Settings changes, dataset validate/import, matches, and API tests are audited.

---

## Media Acquisition Intelligence — `/api/media-acquisition`

`@Controller('media-acquisition')` (`MediaAcquisitionController`) guarded by
`JwtAuthGuard` + `PermissionsGuard` — tag `media-acquisition`. The **Smart Download**
engine: decides **what** to acquire with explainable decisions and — for auto or
approved decisions with a download URL — executes them (adds the torrent, removes the
superseded one on an upgrade). See [SMART_DOWNLOAD.md](SMART_DOWNLOAD.md) and
[MEDIA_ACQUISITION_INTELLIGENCE.md](MEDIA_ACQUISITION_INTELLIGENCE.md).

| Method | Path | Permission |
|--------|------|------------|
| `GET`    | `/api/media-acquisition/overview` | `media_acquisition.view` |
| `GET`    | `/api/media-acquisition/watchlist` · `/watchlist/:id` | `media_acquisition.view` |
| `POST`   | `/api/media-acquisition/watchlist` | `media_acquisition.manage_watchlist` |
| `PATCH`  | `/api/media-acquisition/watchlist/:id` | `media_acquisition.manage_watchlist` |
| `DELETE` | `/api/media-acquisition/watchlist/:id` | `media_acquisition.manage_watchlist` |
| `GET`    | `/api/media-acquisition/profiles` · `/profiles/:id` | `media_acquisition.view` |
| `POST`   | `/api/media-acquisition/profiles` | `media_acquisition.manage_profiles` |
| `PATCH`  | `/api/media-acquisition/profiles/:id` | `media_acquisition.manage_profiles` |
| `DELETE` | `/api/media-acquisition/profiles/:id` | `media_acquisition.manage_profiles` |
| `POST`   | `/api/media-acquisition/evaluate` | `media_acquisition.evaluate` |
| `POST`   | `/api/media-acquisition/simulate` | `media_acquisition.view` |
| `GET`    | `/api/media-acquisition/evaluations` · `/evaluations/:id` | `media_acquisition.view` |
| `GET`    | `/api/media-acquisition/waiting` · `/upgrades` · `/rejected` | `media_acquisition.view` |
| `GET`    | `/api/media-acquisition/missing-episodes` · `/missing-episodes/:id` | `media_acquisition.view` |
| `GET`    | `/api/media-acquisition/missing-episodes/:id/seasons` | `media_acquisition.view` |
| `POST`   | `/api/media-acquisition/missing-episodes/scan` · `/:id/ignore` · `/:id/unignore` | `media_acquisition.manage_watchlist` |
| `GET`    | `/api/media-acquisition/missing-movies` | `media_acquisition.view` |
| `POST`   | `/api/media-acquisition/missing-movies/scan` · `/:id/ignore` · `/:id/unignore` | `media_acquisition.manage_watchlist` |
| `GET`    | `/api/media-acquisition/approval-queue` | `media_acquisition.view` |
| `POST`   | `/api/media-acquisition/evaluations/:id/approve` | `media_acquisition.approve` |
| `POST`   | `/api/media-acquisition/evaluations/:id/reject` | `media_acquisition.reject` |
| `POST`   | `/api/media-acquisition/evaluations/:id/override` | `media_acquisition.override` |
| `GET`    | `/api/media-acquisition/history` | `media_acquisition.history` |
| `GET`    | `/api/media-acquisition/recommendations` | `media_acquisition.view` |
| `GET`    | `/api/media-acquisition/settings` | `media_acquisition.settings` |
| `PATCH`  | `/api/media-acquisition/settings` | `media_acquisition.settings` |
| `POST`   | `/api/media-acquisition/export` | `media_acquisition.export` |

---

## Release Scoring — `/api/release-scoring`

`@Controller('release-scoring')` (`ReleaseScoringController`) guarded by
`JwtAuthGuard` + `PermissionsGuard` — tag `release-scoring`.

| Method | Path | Permission |
|--------|------|------------|
| `POST` | `/api/release-scoring/score` | `release_scoring.view` |
| `POST` | `/api/release-scoring/test-rule` | `release_scoring.view` |

`score` returns `{ score (0–100), decision, reasons[], warnings[], parsed }`.

---

## Modules — `/api/modules`

`@Controller('modules')` (`ModuleRegistryController`) guarded — tag `modules`.
Exposes the module registry: which feature modules are enabled and the current
module-availability status. There is no licensing or edition gating — every
module is available and access is governed only by RBAC. This reports the single
`community` product with every `core` and `community` module available.

| Method | Path | Auth | Permission |
|--------|------|------|------------|
| `GET`  | `/api/modules/enabled` | Bearer | — enabled modules (used by clients to build navigation) |
| `GET`  | `/api/modules/license` | Bearer | — module-availability status (no gating; always the single `community` product) |
| `GET`  | `/api/modules` | Bearer | `modules.view` |
| `GET`  | `/api/modules/:id` | Bearer | `modules.view` |
| `GET`  | `/api/modules/:id/manifest` | Bearer | `modules.view` |
| `GET`  | `/api/modules/:id/health` | Bearer | `modules.view` |
| `POST` | `/api/modules/:id/enable` | Bearer | `modules.manage` |
| `POST` | `/api/modules/:id/disable` | Bearer | `modules.manage` |

---

## System — `/api/system`

`@Controller('system')` (`SystemController`) — tag `system`.

| Method | Path | Auth | Permission | Description |
|--------|------|------|------------|-------------|
| `GET` | `/api/system/live` | **Public** | — | Liveness: `{ status: "ok", uptime }` |
| `GET` | `/api/system/ready` | **Public** | — | Readiness: `{ status, database }` (DB ping) |
| `GET` | `/api/system/version` | **Public** | — | `{ product, version, edition, apiVersion, gitSha, buildTime, node }` — `edition` is `community` |
| `GET` | `/api/system/health` | Bearer | `system.view` | Detailed: process info, per-engine health, and disk usage for each file-manager root |
| `GET` | `/api/system/update` | Bearer | `system.view` | Current update status (last check, available version) |
| `POST` | `/api/system/update/check` | Bearer | `system.view` | Check for an update now |
| `PATCH` | `/api/system/update/settings` | Bearer | `system.manage` | Update the update-check settings |

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

On a valid token the socket joins three kinds of room; an invalid token
disconnects it (`modules/realtime/realtime.gateway.ts`):

- **`authenticated`** — every authenticated socket. Permission-free events (the
  in-app `notification`) are emitted here.
- **`user:<id>`** — private, for per-user delivery.
- **`perm:<key>`** — one room per *view* permission the socket actually holds, out
  of `torrents.view`, `files.view`, `media_manager.view`,
  `media_acquisition.view`, `media_server_analytics.view`, `rss.view`,
  `notifications.view`. A `SUPER_ADMIN` joins all of them.

Every event is routed to exactly one room by its name prefix, so a client never
receives realtime data it could not read over REST. Events
(`packages/shared/src/events.ts`):

| Event (`WS_EVENTS`) | Payload | Room / scope |
|---------------------|---------|--------------|
| `torrents:update` (`TORRENTS_UPDATE`) | `{ engineId, torrents: NormalizedTorrent[], at }` | `torrents.view` — each sync tick (~2 s) |
| `stats:update` (`STATS_UPDATE`) | `{ engineId, stats: GlobalStats, at }` | `torrents.view` — each sync tick |
| `engine:status` (`ENGINE_STATUS`) | `{ engineId, online, error, at }` | `torrents.view` — each sync tick / on engine failure |
| `files.operation.{started,progress,completed,failed}`, `files.cleanup.completed`, `files.trash.updated` | — | `files.view` |
| `media_manager.job.{started,progress,completed,failed}` | `MediaJobEventPayload` | `media_manager.view` |
| `imdb.dataset.validate.{started,completed,failed}` | `ImdbEventPayload` | `media_manager.view` |
| `imdb.dataset.download.{started,progress,completed,failed}` | `ImdbEventPayload` | `media_manager.view` |
| `imdb.dataset.import.{progress,completed,failed,cancelled}` | `ImdbEventPayload` | `media_manager.view` |
| `imdb.match.completed` · `imdb.enrichment.completed` | `ImdbEventPayload` | `media_manager.view` |
| `rss.show_status.{lookup.completed,lookup.failed,changed}`, `rss.rule.created_for_inactive_show`, `rss.show.{became_active,ended,canceled}` | — | `rss.view` |
| `notification.{sent,failed,retry,rule.triggered}`, `notification.queue.updated`, `notification.provider.{online,offline}` | — | `notifications.view` (Notification Center) |
| `notification` (`NOTIFICATION`) | `{ id, level, title, message, createdAt }` | **Permission-free** — the `authenticated` room, or `user:<id>` for a targeted notification |
| `torrent:update` / `system:health` | — | Declared in `WS_EVENTS` but never emitted (reserved) |

Note the two distinct notification families: the dotless `notification` event is
the in-app inbox item and is *not* permission-scoped, while the dotted
`notification.*` events are Notification Center delivery telemetry and require
`notifications.view`.

The `imdb.*` events never carry secrets; `ImdbEventPayload` fields include
`id`/`itemId`/`imdbId`, `status`, `progress`, `message`, `recordsImported`,
`filesImported[]`, and `at`.

---

## Not yet exposed

The API now exposes the large majority of the data model over HTTP. A few items
remain modeled in the schema without a dedicated endpoint:

- **Download paths** (`DownloadPath`) and **system events** (`SystemEvent`) have no
  controller.
- **API-key authentication.** Keys are issuable and revocable
  ([above](#api-keys--apiapi-keys)) but are **not accepted as a credential on any
  request** — no guard or strategy reads `ApiKey.keyHash`, so `scopes`,
  `expiresAt` and `lastUsedAt` are inert. Every route authenticates via JWT.
- **Torrent rename.** The `torrents.rename` permission exists in the catalog (and
  is granted to `POWER_USER`), but no REST route consumes it. The provider
  capability is uneven: qBittorrent implements `renameTorrent`/`renameFile`,
  while **rTorrent throws for both** — `d.name` is derived from the metadata and
  is read-only, so the provider now fails loudly rather than silently no-op'ing.
  The only in-tree caller is the internal placeholder-name repair
  (`TorrentNameRepairService`), which degrades gracefully on that error.
