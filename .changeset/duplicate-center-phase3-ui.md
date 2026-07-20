---
"ultratorrent": minor
---

Duplicate Center Phase 3 (part 3) — the cleanup UI and Trash & Recovery, completing the Scan → Review → Keep Best → Preview → Clean Up → Verify loop.

The comparison view previously ended with a note that cleanup arrived later. It now ends with **Clean up…**, which opens a preview-then-confirm dialog. The dialog never builds a plan itself: it asks the server for one, renders exactly that, and sends back only the `resolutionId` — so what executes is what the operator read, and a client cannot hand-craft a list of files to delete.

The preview shows the copy being kept, every file bound for Trash (with sidecars badged as such), the reclaim estimate, and — prominently — that files go to Trash and stay restorable until retention expires. Subtitles that exist only on the copy being removed get their own warning panel explaining they are being left in place rather than deleted. Blockers disable the confirm button outright.

Outcomes are reported honestly: `completed` is a success toast, while `partial` and `failed` surface as errors naming how many were trashed, skipped and failed. An HTTP 200 carrying failures shown as "done" is how an operator learns to distrust the tool.

**Trash & Recovery** joins as the eighth tab. It lists the resolution *journal* joined to live Trash entries rather than the Trash table alone, which matters after retention passes: the journal outlives the Trash entry, so a purged file still appears with an explicit "no longer in Trash" state instead of silently vanishing from the history. Restore reuses the existing `/files/trash/restore` route — the Trash surface already worked, and a duplicate-scoped copy of it would have been a second source of truth for something already knowable from the journal.

33 new i18n keys per locale (132 total for this feature), en-US and es-PR at parity.
