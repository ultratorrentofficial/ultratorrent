---
"ultratorrent": patch
---

The Jobs Center no longer shows users raw JSON. Opening a completed metadata refresh printed `inputSummary` through JSON.stringify, so the operator was shown a blob containing `"itemId": null, "libraryId": null` and reasonably concluded the job had no idea what to work on. It did: the job carried its item, and libraryId is null BY DESIGN on that path because a selection can span libraries. The data was correct and the presentation asserted a failure that had not happened. Summaries now render as readable facts — unset fields are omitted rather than printed as `null`, keys read as words (`libraryId` → Library, `itemIds` → Items), and values format by meaning (byte counts as sizes, timestamps as dates, booleans as yes/no, long id lists as a count and a sample). No raw-JSON escape hatch: an operator surface should not require reading JSON to find out what happened.
