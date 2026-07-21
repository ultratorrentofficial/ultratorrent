---
"ultratorrent": minor
---

Duplicate cleanup: remove only the media file, and add an optional permanent delete.

Two changes to how a duplicate copy is removed (Keep this / Delete / Clean up / Quick Clean):

**Only the media file is trashed now — never its sidecars.** Previously a cleanup also trashed the removed copy's `.nfo`, `-thumb.jpg` and same-language subtitles (with an orphaned-subtitle safeguard for unique-language subs). It now removes the video and nothing else: artwork, NFO and subtitles are left in place. The operator asked for the redundant *media* to go, not its metadata — a stray `.nfo` beside a kept copy is harmless, while a deleted poster or subtitle is content they did not ask to lose. The reclaim estimate counts only the media file, and the preview says plainly that companion files are left alone.

**A permanent-delete option.** These are large files, and an operator who is sure does not want a redundant 30 GB copy sitting in Trash for the whole retention window. The cleanup dialog and Quick Clean now offer a "Delete permanently (skip Trash)" toggle — off by default, so Trash remains the safe path unless explicitly opted out. When set, the confirm button reads "Delete permanently" and the files are removed outright, freeing the space immediately. It flows through `resolve`/`bulkResolve` (and the REST endpoints) as a confirm-time flag: it changes *how* the approved files are removed, never *which* ones, so the preview-then-confirm guarantee is intact. Audited with the `permanent` flag recorded.

Gated on the existing `media_manager.delete` permission (a dedicated elevated permission could be added later if stricter control is wanted).
