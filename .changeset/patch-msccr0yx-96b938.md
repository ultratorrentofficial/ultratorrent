---
"ultratorrent": patch
---

A media job now records what it was actually asked to do. Opening a completed metadata refresh showed '{ libraryId: null, itemId: null }', which reads as a job that had no idea what to work on. It knew: it refreshed the item and wrote its metadata a second later. The summariser read only libraryId and itemId, while Library Browser's bulk path carries its targets in the PAYLOAD — so it asserted nulls for fields the caller never used and ignored the one holding the answer. It now reads the payload, names the single item a one-item bulk targets, lists them when there are several, passes through the rest of the payload, and omits what is genuinely absent instead of claiming null. The job ROW also gets its mediaItemId for a one-item bulk, so the Jobs Center can link and filter by the item rather than showing an unattributed job.
