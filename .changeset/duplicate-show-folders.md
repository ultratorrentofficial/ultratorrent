---
'@ultratorrent/backend': minor
'@ultratorrent/frontend': minor
---

feat(media): find duplicate show folders and let the operator decide which is real

A show that ended up in two directories — `Happy's Place (2024)` beside `Happys
Place`, `Magnum P.I. (2018)` beside `Magnum P.I (2018)` — can now be reconciled.

New `MediaShowDuplicateService`, with `GET /api/media/shows/duplicates`,
`POST /api/media/shows/duplicates/preview` and `POST /api/media/shows/duplicates/merge`
(the merge requires **both** `media_manager.rename` and `media_manager.delete`),
surfaced on the Media Duplicates page. This is deliberately not the existing
`MediaDuplicateService`, which groups duplicate *files*; this groups the directories.

Detection ties folders together by a shared canonical name **with compatible years**,
or by a shared IMDb id. Both guards matter:

- The year check keeps genuinely different shows apart. `Dark Matter (2015)` and
  `Dark Matter (2024)` canonicalize identically — as do `Invasion` and `Tracker` —
  and must never be collapsed.
- An id-only match is flagged `needsReview`, because one mis-tagged item is enough to
  produce it. A real library had `Masters of the Air` carrying High Desert's
  `tt13701758`; merging on that would move one show's episodes into the other.

**Nothing is automatic.** Detection only reports. The operator picks the real path,
sees an exact preview of every move, trash and delete, and confirms. The merge:

- re-homes each video file into the chosen folder;
- on a same-episode collision, keeps the **larger** file and sends the smaller to
  **Trash** — never straight to deletion;
- permanently deletes a duplicate folder **only once it holds no video file**;
- re-points watchlist items bound to a merged show *before* the row is dropped,
  since the FK's `ON DELETE SET NULL` would otherwise silently unbind the show;
- refuses outright to delete a library root, or to merge a folder into itself.

Separately, creating or updating a library now launches the same detached scan the
Scan button runs, so a new or re-pathed library populates its items — and its
`MediaShow` rows — immediately instead of sitting empty until someone notices.
