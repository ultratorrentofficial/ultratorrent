-- AlterTable: alternate show titles a monitored series is released under.
--
-- Show identity is matched token-for-token against a release's title region, so a
-- release that renames the show is otherwise unreachable — Riverdale ships as
-- "Riverdale US", The Bad Batch as "Star Wars The Bad Batch". An alias adds another
-- title that counts as this show; it never loosens the comparison itself.
--
-- Empty array default so every existing row is valid without a backfill.
ALTER TABLE "media_acquisition_watchlist_items"
ADD COLUMN     "titleAliases" TEXT[] DEFAULT ARRAY[]::TEXT[];
