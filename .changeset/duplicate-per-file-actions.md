---
"ultratorrent": minor
---

Duplicate Center — per-file Keep and Delete buttons on each copy in a group.

The comparison view showed every duplicate copy side by side but put the whole decision behind one "Clean up" button that always kept the engine's recommended copy. The decision now lives on each file.

Every copy in a group gets two buttons:

- **Keep this** — keep this copy and send every other copy in the group to Trash. The group collapses to one file. (This is the existing keep-one cleanup, now reachable per copy instead of only for the recommended one.)
- **Delete** — send only this copy to Trash and keep the rest. For thinning a three-plus group without collapsing it to a single keeper.

Both open the same preview-then-confirm dialog and neither acts on click. The dialog asks the server for a plan, shows exactly that plan, and sends back only its id — a client still cannot hand-craft a delete list.

The per-file delete adds one invariant beyond the shared safeguards: **it can never remove the last copy.** The plan records every surviving copy's path, and execution refuses if none of them still exists on disk — so even a race that removed the other copies between preview and confirm cannot leave zero copies of the media. Subtitle safety generalises the same way: a language is safe to trash on the removed copy only if some surviving copy still has it; a language that exists nowhere among the survivors is reported as orphaned, not deleted. And a single-file deletion does **not** mark the group resolved — two-plus copies may still be duplicated afterwards, so the group stays open for the next detection run to reconcile.

New endpoint `POST /api/media/duplicates/:groupId/preview-delete`; execution reuses the existing `resolutions/:id/resolve` route, whose survivor guard was generalised from "the keeper exists" to "at least one surviving copy exists" (identical behaviour for a keep-one plan, where the sole survivor is the keeper).

Backend: 5 new resolution-service tests (plan trashes only the named copy, refuses a non-member, refuses a library-root path, leaves the group open, refuses when every survivor vanished). Frontend: new DuplicateComparison test (5) covering both buttons, the server-plan-only execution, and a surfaced blocker. en-US and es-PR at parity.
