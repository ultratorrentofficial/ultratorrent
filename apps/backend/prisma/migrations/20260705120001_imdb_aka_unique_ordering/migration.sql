-- Make alternate-title imports idempotent: (titleId, ordering) is IMDb's
-- natural key for an AKA row, so a re-import can skip duplicates instead of
-- appending. Backward-compatible (unique index only; existing rows have a
-- NULL ordering which Postgres treats as distinct).
CREATE UNIQUE INDEX "imdb_akas_titleId_ordering_key" ON "imdb_akas"("titleId", "ordering");
