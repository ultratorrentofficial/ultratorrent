# File Manager

UltraTorrent ships a path-safe file manager for the directories your torrent
engine writes to. It is part of the **core `files` module** and is gated only by
granular `files.*` RBAC permissions.

- REST surface: [API.md → Files](API.md#files--apifiles)
- Security model: [SECURITY.md → File-path validation](SECURITY.md#file-path-validation)
- Backend: `apps/backend/src/modules/files/`
- Frontend: `apps/frontend/src/pages/FilesPage.tsx` + `components/files/`

---

## Capabilities

| Capability | Endpoint | Permission |
|------------|----------|------------|
| Browse a directory | `GET /api/files` | `files.view` |
| Properties (size, item count, ext, sha-256) | `GET /api/files/properties` | `files.view` |
| Preview text (≤ 256 KB) | `GET /api/files/preview` | `files.preview` |
| Download a file | `GET /api/files/download` | `files.download` |
| Inspect a path (in-root? exists? readable/writable?) | `GET /api/files/inspect` | `files.view` |
| Create folder | `POST /api/files/folders` | `files.create_folder` |
| Ensure a directory exists (recursive, idempotent) | `POST /api/files/ensure-dir` | `files.create_folder` |
| Rename file/folder | `POST /api/files/rename` | `files.rename` |
| Move file/folder | `POST /api/files/move` | `files.move` |
| Copy file/folder (recursive) | `POST /api/files/copy` | `files.copy` |
| Delete (Trash or permanent) | `POST /api/files/delete` | `files.delete` |
| Bulk move/copy/delete/cleanup | `POST /api/files/bulk` | `files.bulk_actions` |
| Cleanup preview / execute | `POST /api/files/cleanup-preview` · `…/cleanup-execute` | `files.cleanup` |
| Trash list/restore/purge/empty | `GET /api/files/trash` · `…/trash/*` | `files.view` / `files.delete` |

`files.manage` is retained as a **legacy umbrella** permission; the file manager
itself uses the granular permissions above.

---

## Configuration

Roots are an explicit allow-list:

```bash
FILE_MANAGER_ROOTS=/downloads,/media   # comma-separated; default /downloads
```

All operations resolve to a path **inside** one of these roots. Keep the list as
narrow as possible. The file manager is confined strictly to `FILE_MANAGER_ROOTS`;
Media Manager library scanning is likewise constrained to these hard roots.

### Default Root Path (admin-configurable)

`FILE_MANAGER_ROOTS` is the deployment's **hard boundary**. Inside it, an admin
(permission `settings.manage_root_path`) can set a **Default Root Path** in
**Settings → Default Root Path** to narrow browsing to a subtree — e.g. hard
roots `= /downloads` and Default Root Path `= /downloads/complete`. It can only
narrow within the hard roots, never widen past them or reach a system directory.

- Stored as the setting `fileManager.defaultRootPath` (empty = use the env
  roots as-is); changed only via `PUT /api/files/root` (validated + audited),
  not the generic settings endpoints.
- `GET /api/files/root` reports the effective root plus exists/readable/writable
  (surfaced in Settings, with a warning if the app can't write there).

### Directory picker

Path fields across the app (Add-Torrent save path, RSS-rule save path, Media
Manager library paths, Automation move/rename destinations, and the Default
Root Path itself) use a **root-limited directory picker** (`PathPicker` /
`DirectoryPicker`): breadcrumbs cannot go above the root, folders can be created
in place (with `files.create_folder`), and the selected path is validated
server-side by `PathSafety` on use. Manual entry stays available but is always
validated. Selected values are stored as **absolute in-root paths** (existing
consumers — engine save path, media destinations — expect absolute paths).

---

## Trash (soft delete)

Deletes are soft by default. A deleted item is moved into a
`.ultratorrent-trash` directory **inside its own storage root** (so it never
crosses a filesystem boundary) and a `TrashItem` row records its original
root-relative path, size, and who deleted it.

- **Restore** returns the item to its original location. It never overwrites an
  existing item unless `overwrite: true` is passed.
- **Purge** permanently removes a single trashed item; **Empty** clears the whole
  trash. Both only ever remove paths that live inside a `.ultratorrent-trash`
  directory.
- The trash directory is hidden from normal browse listings.
- Pass `permanent: true` to `delete` to bypass the trash entirely (irreversible).

---

## Cleanup Wizard

The wizard scans a folder and classifies removable candidates. **It never deletes
automatically** — `cleanup-preview` is read-only; you select what to remove and
`cleanup-execute` removes only those paths (to Trash by default).

Categories (`CleanupCategory` in `@ultratorrent/shared`):

| Category | Heuristic |
|----------|-----------|
| `sample_files` | Video files whose name contains `sample` |
| `empty_folders` | Folders whose every child is also being removed |
| `zero_byte_files` | Files of size 0 |
| `duplicate_files` | Identical size **and** sha-256 (keeps the first) |
| `orphan_subtitles` | Subtitle with no video file in its folder |
| `orphan_artwork` | Image with no video file in its folder |
| `nfo_files` / `sfv_files` / `txt_files` | By extension |
| `hidden_temp_files` | Dotfiles, `~`/`.tmp`/`.bak`, `Thumbs.db`, `.DS_Store` |
| `partial_downloads` | `.part`, `.crdownload`, `.aria2`, `.!ut`, … |

The preview returns per-category groups (item count + bytes) and an
`estimatedSpaceSaved` total. Each candidate is individually selectable in the UI.

---

## Real-time & auditing

Mutating operations broadcast over the `/ws` channel:
`files.operation.started`, `files.operation.progress`,
`files.operation.completed`, `files.operation.failed`, `files.cleanup.completed`,
and `files.trash.updated`. The frontend uses these to live-refresh the current
listing.

Every operation writes an audit row (`AuditService`): `file.created_folder`,
`file.renamed`, `file.moved`, `file.copied`, `file.deleted`,
`file.cleanup_execute`, `file.restore`, `file.trash_empty`, `file.bulk.<op>`,
`files.ensure_dir`, and `file.operation_failed` (with the intended action +
error) — including the user, source/destination, byte count, and result.

---

## Safety guarantees

The backend is authoritative; the frontend only hides what a user cannot do.
Every path routes through `PathSafety`, which defeats `../` traversal,
absolute-path escape, NUL bytes, invalid names, and symlink escapes, and refuses
to operate on a configured root, the filesystem root, or a system directory. See
[SECURITY.md](SECURITY.md#file-path-validation) for the full list.
