-- Optimized IMDb movie-import support. All changes are additive and
-- backward-compatible: new nullable columns and new indexes only.

-- IMDbAka: retain the source ordering column (alternate-title rank).
ALTER TABLE "imdb_akas" ADD COLUMN "ordering" INTEGER;

-- IMDbDatasetImport: record the strategy used and the optimized-import
-- scan/skip counters (ImportStats) for the "last import stats" admin view.
ALTER TABLE "imdb_dataset_imports" ADD COLUMN "stats" JSONB;
ALTER TABLE "imdb_dataset_imports" ADD COLUMN "strategy" TEXT;

-- Indexes tuned for the optimized movie import + release-name matching:
--   (titleType, startYear) — movie-like titles filtered by year
--   isAdult                — exclude adult titles cheaply
--   genres (GIN)           — genre filtering over the String[] column
--   akas.title             — release-name matching via alternate titles
CREATE INDEX "imdb_titles_titleType_startYear_idx" ON "imdb_titles"("titleType", "startYear");
CREATE INDEX "imdb_titles_isAdult_idx" ON "imdb_titles"("isAdult");
CREATE INDEX "imdb_titles_genres_idx" ON "imdb_titles" USING GIN ("genres");
CREATE INDEX "imdb_akas_title_idx" ON "imdb_akas"("title");
