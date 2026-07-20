---
"ultratorrent": minor
---

Duplicate Center Phase 2 (UI) — the `/media/duplicates` page becomes a tabbed centre with server-side search and sorting, a side-by-side comparison, and persistent "not duplicates".

The page previously stacked two unrelated sections and rendered a flat table per group. Duplicate **files** had no action at all: the keep/remove selection was React state, annotated in the source as *"no destructive backend action exists"*, and it was discarded on paging. The two halves taught contradictory lessons — a careful destructive workflow above, a decision surface with no consequence below.

**Tabs are server-side views**, not client-side slices of a bulk download: Needs Review (the default), All Open, Movies, TV Episodes, Show Folders, Ignored, Resolved. Each carries the filter the server applies, so a 30,000-file library pages like a small one. Search and sort hit the API too. Four counters at the top come from the single `overview` aggregate — no group rows are loaded to produce them.

**Comparison view.** Candidates render side by side, and rows where they disagree are highlighted — the disagreement is the entire point. Technical data is split into two labelled sections rather than interleaved: *Measured from the file* (dimensions, bitrate, runtime, audio channels, frame rate — read from the container) and *Read from the file name* (resolution, codec, HDR, release group). Those parsed fields are absent on most of a renamed library because the renamer strips the tokens, so mixing them with measured values would fill the table with blanks that read as "we could not read this file" instead of "the name never claimed it". The headings say which is which.

**"Not duplicates" persists.** The action writes through to the group's durable identity, so an ignored group stays hidden across future scans and can be reopened from the Ignored tab.

Only tabs with a backend behind them exist. Trash & Recovery and Settings arrive with the phases that implement them rather than shipping as empty shells, and the comparison view states plainly that cleanup actions come later instead of offering a button that does nothing.

99 i18n keys per locale, en-US and es-PR at parity.
