-- Drop three indexes on `imdb_titles` that no query can use.
--
-- Two of them are superseded, not merely idle. Every title lookup in the
-- codebase matches case-insensitively — `{ equals: query, mode: 'insensitive' }`
-- in imdb-show-status.provider.ts and imdb-metadata.provider.ts — which Prisma
-- renders as ILIKE. A btree cannot answer ILIKE, so `imdb_titles_primaryTitle_idx`
-- and `imdb_titles_originalTitle_idx` were unreachable for the only query shape
-- that exists. Verified on a live 8.97M-row catalogue:
--
--   ILIKE 'Silo'  ->  Bitmap Index Scan on imdb_titles_primary_title_trgm_idx
--   =     'Silo'  ->  Index Scan using "imdb_titles_primaryTitle_idx"   (no caller)
--
-- The GIN trigram indexes that `ImdbTrigramIndexService` builds at runtime took
-- over that work; these two were left behind and cost ~295 MB each.
--
-- The third, `imdb_titles_titleType_idx`, is a strict prefix of
-- `imdb_titles_titleType_startYear_idx` — Postgres serves `titleType`-only
-- predicates from the composite, so the single-column copy was pure overhead.
--
-- ~645 MB reclaimed on a full catalogue (295 + 294 + 56). Measured on an
-- 8.97M-row imdb_titles: total index size 2496 MB -> 1852 MB. Index-only: no data is touched
-- and no query loses a path, so this is safe to re-run and safe to roll back by
-- recreating the indexes.
--
-- CONCURRENTLY is deliberately NOT used: Prisma wraps each migration in a
-- transaction, and DROP INDEX CONCURRENTLY cannot run inside one. A plain DROP
-- takes a brief ACCESS EXCLUSIVE lock on `imdb_titles`, which is acceptable
-- because it completes in milliseconds — it unlinks a file, it does not scan.

DROP INDEX IF EXISTS "imdb_titles_primaryTitle_idx";
DROP INDEX IF EXISTS "imdb_titles_originalTitle_idx";
DROP INDEX IF EXISTS "imdb_titles_titleType_idx";
