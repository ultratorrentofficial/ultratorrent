-- Add-Series workflow: episodes outside the operator's requested acquisition
-- scope are "not wanted" (distinct from "missing"). The missing-episode sweep
-- and the series backfill job both skip these; scanSeries preserves the flag.
-- Queries always narrow by watchlistItemId first (already indexed), so this
-- low-cardinality boolean needs no index of its own.
ALTER TABLE "wanted_episodes"
  ADD COLUMN "excludedFromScope" BOOLEAN NOT NULL DEFAULT false;
