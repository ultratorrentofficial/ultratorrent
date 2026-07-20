-- Deduplicate media_items, then enforce one row per (libraryId, path).
--
-- The scanner checked for an existing row and then created one as two separate
-- statements, so two concurrent scans of the same library both saw "not present"
-- and both inserted. On a live deployment this produced 139 duplicated rows, all
-- within 7 seconds of one another. Each pair then appeared in the Duplicate
-- Center as a group whose two members were the SAME file on disk, so a cleanup
-- would have offered to trash the copy it was keeping.
--
-- The surviving row is the one carrying the most derived data (artwork + NFO),
-- because that is the ONLY thing that differed between pairs on the live data:
-- files, metadata, external IDs and subtitles were identical in all 139 cases,
-- and artwork/NFO differed in 79 and 78 of them respectively. Ties break to the
-- oldest row so createdAt history is preserved, then to the lowest id so the
-- result is deterministic. Children of the removed rows cascade.

WITH ranked AS (
  SELECT
    i.id,
    ROW_NUMBER() OVER (
      PARTITION BY i."libraryId", i.path
      ORDER BY
        (SELECT count(*) FROM media_artwork a WHERE a."itemId" = i.id)
      + (SELECT count(*) FROM media_nfo_files n WHERE n."itemId" = i.id) DESC,
        i."createdAt" ASC,
        i.id ASC
    ) AS rn
  FROM media_items i
)
DELETE FROM media_items
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Duplicate groups left with fewer than two members are meaningless. This clears
-- both the groups emptied by the dedupe above and the orphans that accumulated
-- because detect() deletes and recreates every group outside a transaction.
DELETE FROM media_duplicate_groups g
WHERE (SELECT count(*) FROM media_items i WHERE i."duplicateGroupId" = g.id) < 2;

CREATE UNIQUE INDEX "media_items_libraryId_path_key" ON "media_items"("libraryId", "path");
