-- Case-insensitive IMDb catalogue lookups were full table scans.
--
-- Prisma renders `mode: 'insensitive'` as ILIKE, and ILIKE cannot use a plain
-- btree index. On the 8.9M-row catalogue that turned every show/movie title
-- lookup into a whole-table scan: `ImdbTvShowStatusProvider.searchShow`
-- (primaryTitle ILIKE + ORDER BY startYear DESC) measured **47.8 seconds** per
-- call on a live host. Those lookups fire per media item (show-status warm-up,
-- identification, missing-episode self-heal), so they saturated the database and
-- starved concurrent work — a movie library scan would sit wedged mid-progress
-- and never finish.
--
-- pg_trgm's GIN operator class makes LIKE/ILIKE index-backed. Same query after:
-- **180 ms** (Bitmap Index Scan) — a ~265x speedup.
--
-- Covers every column the code ILIKEs: imdb_titles.primaryTitle / originalTitle
-- (equals+contains searches) and imdb_akas.title (the AKA recall search).
--
-- NOTE: building these on a fully-imported catalogue takes a few minutes and
-- holds a SHARE lock on the table (blocking writes, not reads) for that time.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "imdb_titles_primary_title_trgm_idx"
  ON "imdb_titles" USING gin ("primaryTitle" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "imdb_titles_original_title_trgm_idx"
  ON "imdb_titles" USING gin ("originalTitle" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "imdb_akas_title_trgm_idx"
  ON "imdb_akas" USING gin ("title" gin_trgm_ops);
