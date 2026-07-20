-- Duplicate Center Phase 6 — scan state and the indexes the real access paths need.
--
-- Measured on a live 29,558-item library: detection took 10.5 s inside the HTTP
-- request. The scan-state row lets an unchanged library skip the write phase
-- entirely; the indexes serve the queries the listing actually issues rather than
-- one column at a time.

CREATE TABLE "media_duplicate_scan_state" (
  "id"          TEXT NOT NULL,
  "inputDigest" TEXT NOT NULL,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_duplicate_scan_state_pkey" PRIMARY KEY ("id")
);

-- The default listing is `WHERE status='open' ORDER BY requiresReview DESC,
-- potentialSavingsBytes DESC`. Postgres cannot combine the existing single-column
-- indexes into that; one composite serves it outright.
CREATE INDEX "media_duplicate_groups_status_requiresReview_savings_idx"
  ON "media_duplicate_groups" ("status", "requiresReview", "potentialSavingsBytes");
CREATE INDEX "media_duplicate_groups_status_potentialSavingsBytes_idx"
  ON "media_duplicate_groups" ("status", "potentialSavingsBytes");
CREATE INDEX "media_duplicate_groups_status_confidence_idx"
  ON "media_duplicate_groups" ("status", "confidence");
CREATE INDEX "media_duplicate_groups_status_createdAt_idx"
  ON "media_duplicate_groups" ("status", "createdAt");
CREATE INDEX "media_duplicate_groups_createdAt_idx"
  ON "media_duplicate_groups" ("createdAt");

-- Size is what every savings figure and quality comparison is computed from.
CREATE INDEX "media_files_size_idx" ON "media_files" ("size");

-- The two identity shapes detection and the missing-episode sweep look up by.
CREATE INDEX "media_items_title_year_idx" ON "media_items" ("title", "year");
CREATE INDEX "media_items_seriesImdbId_season_episode_idx"
  ON "media_items" ("seriesImdbId", "season", "episode");
CREATE INDEX "media_items_updatedAt_idx" ON "media_items" ("updatedAt");
