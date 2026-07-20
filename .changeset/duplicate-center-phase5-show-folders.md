---
"ultratorrent": minor
---

Duplicate Center Phase 5 — the duplicate show-folder workflow becomes a plan the operator approves, and stops destroying subtitles.

Three defects, all recorded in `docs/DUPLICATES_REDESIGN_REVIEW.md`.

**The plan that executes is now the plan that was approved.** `merge(canonicalShowId, duplicateShowIds)` recomputed its plan at execute time — the operator read one preview and the server ran whatever the disk looked like a moment later. `preview` now persists the plan and the merge route takes **only a `planId`**, so a client cannot hand-craft a list of files to move and delete either. A show family has no `version` column to pin to, so the plan is pinned to a **sha256 of every input file's path and size**: anything added, removed or resized in those folders between preview and confirm fails with a 409 rather than acting on a plan nobody reviewed. Every step is journalled before it is attempted, and each path is revalidated — hard roots, library-root protection, existence, size, destination-free — immediately before it is touched.

**Sidecars ride with their video.** The merge moved video files only and then *permanently* deleted the duplicate folder, which destroyed every `.srt` in it. A subtitle is content, not a by-product. Sidecars now move with the episode they belong to (the same structural basename rule the renamer and the file-level cleanup use, so show-level `poster.jpg`/`tvshow.nfo`/`theme.mp3` are still never touched), a collision loser's `.nfo` and artwork are trashed with it, and a **subtitle language the surviving copy lacks is rescued** — carried into the canonical folder and renamed onto the winner's stem, because the folder it lived in is about to go. Folders now go to **Trash**, not `rm`, and only once they hold no video *and* no subtitle; the `MediaShow` row is dropped only if the folder actually went, since deleting the row for a surviving folder would hide it from the next detection pass.

**Collision winners can be chosen.** They were decided solely by file size — a proxy for quality, and a poor one; a bloated upscale beats a clean 1080p on bytes alone. `collisionChoices` lets the operator override per episode, validated server-side against that episode's actual files.

Detection now reports what each folder actually contributes: the episodes **only that folder has**, the family's colliding episodes, subtitle/NFO/artwork counts, and watchlist links — the numbers the choice turns on. An external-ID-only family is labelled `Metadata Conflict — Manual Review Required` and carries a blocker until explicitly acknowledged, so "never merge solely because of a suspicious external ID" is enforced rather than advised.

A completed merge launches the standard three-stage rescan — which is what files the moved episodes into `Season NN`, using the library's own naming template rather than this service second-guessing it — and best-effort refreshes every enabled media server.

Additive migration: `media_duplicate_resolutions` gains `scope`, a nullable `groupId`, `canonicalShowId` and `inputFingerprint`. The table is shared with file-level cleanups because both need the same store-then-execute property; `DuplicateResolutionService.resolve` refuses anything whose `scope` is not `group`.

62 i18n keys per locale for the workflow, en-US and es-PR at parity.
