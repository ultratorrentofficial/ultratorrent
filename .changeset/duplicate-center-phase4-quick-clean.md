---
"ultratorrent": minor
---

Duplicate Center Phase 4 — Quick Clean and bulk cleanup, with partial results reported as partial.

**Quick Clean** cleans many high-confidence groups without opening each one. Eligibility is decided **server-side**: a group qualifies only if the recommendation engine both declined to flag it for review *and* nominated a keeper. Those two conditions are the same condition — the engine sets `recommendedItemId` to null whenever it forces review, precisely so a bulk path cannot sweep up the cases a human was meant to see. A client cannot ask for a group outside that set.

Nothing is pre-selected. "Select all" is one click away, but the default is a deliberate choice rather than a full basket the operator has to empty. Selecting groups then builds **real server-side plans**, so the totals shown are what those plans produced, not a client-side estimate — and only then does the confirm button appear, labelled with the file count and reclaim it will actually perform.

**Bulk preview refuses a review-required group rather than dropping it silently.** Quietly omitting it would let a caller believe a selection was fully planned when part of it was ignored; an explicit per-group keeper makes such a group eligible. Both bulk endpoints are capped at 100 groups — a blast-radius limit, not a performance one.

**Partial is not success.** Bulk resolve runs each plan independently, so one failure does not abort the rest, and follows the existing `{ succeeded, failed, results[] }` envelope with `partial` counted as **not ok**. The UI surfaces a partial run as an error naming how many succeeded and failed, and deliberately **keeps the selection** so the operator can see what remains rather than starting from nothing. An HTTP 200 carrying failures rendered as "done" is how an operator learns to distrust the tool.

Fixing a genuinely failing bulk test also exposed a *passing* one that passed for the wrong reason: its fake paths tripped the keeper-existence guard before `files.remove` was ever reached, so it asserted a failure it never actually caused. The bulk tests now write real files, which is the only way the resolve path under test is reached at all.

8 new backend tests (1405 total). 23 new i18n keys per locale, 155 for this feature, en-US and es-PR at parity.
