-- Backfill `wanted_episodes.torrentHash` for grabs that predate the column.
--
-- Without this the dead-grab reconciler is inert on exactly the installs that
-- need it. It matches a stuck episode to its torrent through `torrentHash`, and
-- every row grabbed before that column existed reads NULL — so the 369 episodes
-- measured stranded on a live install (357 of them over a week old) would have
-- stayed stranded while the feature reported itself working.
--
-- The hash was never lost, only unindexed: the executor records it on the
-- download action as `result->>'torrentHash'`, reachable from the wanted row via
-- `grabbedEvaluationId`. 338 of the 369 resolve this way; the remainder had no
-- action row (advisory evaluations that never produced a download) and correctly
-- stay NULL rather than being guessed at.
--
-- DISTINCT ON because an evaluation can carry more than one action — a retry, or
-- an upgrade that superseded an earlier grab. Newest wins, which is the torrent
-- the episode is actually waiting on.
--
-- Touches only rows that are still `grabbed` and still missing. A completed or
-- abandoned episode has nothing to reconcile, and writing a hash onto it would
-- invite a later pass to act on a download that no longer matters.

UPDATE "wanted_episodes" w
SET "torrentHash" = a.hash
FROM (
  SELECT DISTINCT ON ("evaluationId")
         "evaluationId",
         result->>'torrentHash' AS hash
  FROM "media_acquisition_actions"
  WHERE "actionType" = 'download_torrent'
    AND result->>'torrentHash' IS NOT NULL
  ORDER BY "evaluationId", "createdAt" DESC
) a
WHERE w."grabbedEvaluationId" = a."evaluationId"
  AND w."torrentHash" IS NULL
  AND w."searchStatus" = 'grabbed'
  AND w.status = 'missing';
