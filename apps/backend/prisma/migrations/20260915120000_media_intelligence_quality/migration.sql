-- Media Intelligence (Phase 2): quality compliance on the derived projection.
--
-- Additive and non-destructive: two nullable columns and one index on the
-- DERIVED `media_intelligence_projections` table. No existing column is
-- altered, no data is rewritten, and nothing is backfilled -- the next
-- reconciliation sweep fills these in, and a NULL until then is honest: it
-- means "this row predates Phase 2", which is deliberately NOT the same claim
-- as the `unknown` verdict a real evaluation can reach.
--
-- Applied with `prisma migrate deploy`. NEVER via a shadow-db diff against a
-- live DATABASE_URL -- `migrate diff --from-migrations` RESETS its target, and
-- doing that to a live database is how ut-dev was wiped.
--
-- On CREATE INDEX: Phase 1 could create indexes inline because its tables were
-- brand new and empty. That justification does NOT apply here -- this table is
-- populated (~4k rows on the live installation). It is still safe, because a
-- few thousand rows build in milliseconds; the prohibition exists for large
-- tables, where the build blocks writes long enough that a killed migration
-- leaves P3009 and a restart-looping backend. Stating the reasoning rather
-- than reusing Phase 1's, which no longer holds.

ALTER TABLE "media_intelligence_projections"
  ADD COLUMN IF NOT EXISTS "qualityStatus"    TEXT,
  ADD COLUMN IF NOT EXISTS "upgradePotential" BOOLEAN;

CREATE INDEX IF NOT EXISTS "media_intelligence_projections_qualityStatus_idx"
  ON "media_intelligence_projections" ("qualityStatus");
