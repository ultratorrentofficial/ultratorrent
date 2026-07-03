# Intelligent Media Renamer (Pro)

The premium Media Renamer (`packages/enterprise/src/media-renamer`, module
`media_renamer_pro`) turns completed downloads into clean, media-server-ready
libraries with **job tracking, dry-run, rollback, and naming templates**. It is
a UPLM-gated premium overlay; the free Community renamer (`media` module)
remains for basic in-place organising.

It **reuses Core's** release parser (`parseTorrentName`), rename planner
(`buildRenamePlan`), and path safety (`PathSafety`) via `@ultratorrent/backend/lib`
— no duplicated business logic.

- [Modes](#modes)
- [Templates](#templates)
- [Workflow](#workflow)
- [Rollback](#rollback)
- [Safety](#safety)
- [API](#api)
- [Permissions](#permissions)
- [Database](#database)

---

## Modes

```
preview · rename_in_place · rename_move · copy · hardlink · symlink
```

**Hardlink/symlink are preferred** — they place the file in the library while
leaving the original in place so seeding continues. `rename_in_place` and
`rename_move` are the only destructive modes (they relocate the original) and
require the `media_renamer.execute` permission.

## Templates

Naming templates (`MediaNamingTemplate`) are per media-type + server preset.
Defaults (Core `PRESET_TEMPLATES`):

```
TV     {Series Title}/Season {season:00}/{Series Title} - S{season:00}E{episode:00} - {Episode Title}.{ext}
Movie  {Movie Title} ({Year})/{Movie Title} ({Year}) - {Quality}.{ext}
Anime  {Series Title}/Season {season:00}/{Series Title} - {episode:000} - {Episode Title}.{ext}
```

`renderTemplate` supports `{Token}`, numeric padding `{Token:00}`, and optional
`{Token?...}` segments, and **sanitizes every path segment** (neutralising
traversal).

## Workflow

1. **Analyze** (`POST /analyze`) — parse the release → media type, parsed
   metadata, confidence score.
2. **Dry-run** (`POST /dry-run`) — build the full rename plan (per-file
   source→destination, action, skip reasons for samples/extras/non-media,
   subtitle matching) and persist a `preview` job. No files are touched.
3. **Execute** (`POST /execute`) — perform the plan with the chosen mode,
   recording each `MediaRenameFile` (final path / error) and the job status.

Samples are ignored, subtitles are renamed to mirror their video, extras are
routed to `Extras/`, and conflicts are flagged as warnings.

## Rollback

`POST /jobs/:id/rollback` reverses a completed job: moved/renamed files are
moved back to their original path; copied/hardlinked/symlinked files (where the
original was preserved) simply have the new file removed. The job is marked
`rolled_back` and the action is audited.

## Safety

- **Path-traversal prevention**: every destination is validated against the
  library root, and every source against the file-manager roots (`PathSafety`),
  in addition to Core's per-segment sanitisation.
- **Seeding preserved**: default modes (hardlink/symlink/copy) never remove the
  original; originals are only relocated in explicitly destructive modes.
- **Never deletes without intent**: there is no delete mode; destructive
  relocation requires `media_renamer.execute`.
- **Audited**: execute and rollback are written to the audit log.

## API

All under `/api/media-renamer`, module-gated (`media_renamer_pro`) + RBAC:

| Method & path | Permission |
|---------------|------------|
| `POST /analyze` · `GET /jobs` · `GET /jobs/:id` · `GET /templates` | `media_renamer.view` |
| `POST /dry-run` | `media_renamer.preview` |
| `POST /execute` | `media_renamer.execute` |
| `POST /jobs/:id/rollback` | `media_renamer.rollback` |
| `POST /templates` · `PATCH /templates/:id` · `DELETE /templates/:id` | `media_renamer.manage_templates` |

## Permissions

`media_renamer.view`, `media_renamer.preview`, `media_renamer.execute`,
`media_renamer.rollback`, `media_renamer.manage_templates`.

## Database

`MediaRenameJob`, `MediaRenameFile`, `MediaNamingTemplate`.

See also: [MULTI_SERVER.md](MULTI_SERVER.md),
[MEDIA_SERVERS.md](MEDIA_SERVERS.md), [UPLM.md](UPLM.md),
[SECURITY.md](SECURITY.md).
