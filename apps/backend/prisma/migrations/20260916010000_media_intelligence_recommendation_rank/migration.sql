-- Media Intelligence (Phase 4): persisted recommendation ordering rank.
--
-- Additive. One defaulted column, and the ordering index it replaces.
--
-- Why a column rather than an ORDER BY: `confidence` is text, and sorting it
-- alphabetically yields high < low < medium -- which puts the advice the
-- system trusts LEAST above the advice it half-trusts. Exactly the defect
-- Phase 3 hit with `severity`, and solved the same way.
--
-- No backfill statement is needed, unlike the Phase 3 rank migration: this
-- table was created empty by the migration immediately before this one and
-- is populated only by the reconciliation sweep, which computes the rank on
-- every write. The DEFAULT of 9 (unknown confidence, sorts last) therefore
-- applies to no existing row anywhere.
--
-- Applied with `prisma migrate deploy`. NEVER a shadow-db diff against a live
-- DATABASE_URL -- `migrate diff --from-migrations` RESETS its target.

ALTER TABLE "media_intelligence_recommendations"
  ADD COLUMN IF NOT EXISTS "confidenceRank" INTEGER NOT NULL DEFAULT 9;

-- The old index ordered on the text column this replaces.
DROP INDEX IF EXISTS "media_intelligence_recommendations_status_confidence_idx";

-- Name matches Prisma's own output verbatim. Prisma truncates to Postgres'
-- 63-character identifier limit, and an index whose name differs from what
-- the schema implies is drift a later `migrate diff` will try to 'repair'.
CREATE INDEX IF NOT EXISTS "media_intelligence_recommendations_status_confidenceRank_c_idx"
  ON "media_intelligence_recommendations" ("status", "confidenceRank", "createdAt");
