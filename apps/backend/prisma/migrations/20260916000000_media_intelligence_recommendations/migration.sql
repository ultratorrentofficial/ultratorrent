-- Media Intelligence (Phase 4): explainable recommendations.
--
-- Additive and non-destructive. ONE new table and its indexes. No existing
-- column is altered, no existing row is rewritten, and nothing is backfilled.
--
-- Phase 3's disposition state (acknowledge / snooze / dismiss, the escalation
-- reason and the transition history) lives on `media_intelligence_findings`
-- and is NOT touched here. Generating a recommendation must never reset what
-- a person decided about the finding underneath it — those are two different
-- questions, and the whole point of keeping them in separate tables is that
-- one cannot silently overwrite the other.
--
-- No synthetic history and no backfill: recommendations are DERIVED and the
-- next reconciliation sweep creates them from findings that already exist.
-- Inserting a row per existing finding at migration time would date them all
-- to today, which is the same lie Phase 3 refused to tell about findings.
--
-- Notification safety: the sweep that first populates this table publishes
-- nothing new. The attention digest is driven by finding transitions, and
-- creating a recommendation is not one.
--
-- Applied with `prisma migrate deploy`. NEVER via a shadow-db diff against a
-- live DATABASE_URL -- `migrate diff --from-migrations` RESETS its target.
--
-- On CREATE INDEX: this table starts EMPTY, so every index below builds
-- instantly. The standing prohibition concerns large populated tables, where
-- a blocking build that gets killed leaves P3009 and a restart-looping backend.

CREATE TABLE IF NOT EXISTS "media_intelligence_recommendations" (
  "id"                  TEXT NOT NULL,
  "findingId"           TEXT NOT NULL,
  -- Denormalized from the finding so the queue filters without a join.
  "entityType"          TEXT NOT NULL,
  "entityId"            TEXT NOT NULL,

  "type"                TEXT NOT NULL,
  "recommendationClass" TEXT NOT NULL,
  "status"              TEXT NOT NULL DEFAULT 'active',
  "confidence"          TEXT NOT NULL,

  "evidence"            JSONB NOT NULL DEFAULT '{}',
  "unknowns"            JSONB NOT NULL DEFAULT '[]',
  "plan"                JSONB NOT NULL DEFAULT '[]',

  "capabilityId"        TEXT,

  -- Availability, which only an explicit search can establish. The default is
  -- deliberately the honest one for a type that needs no external check.
  "verification"        TEXT NOT NULL DEFAULT 'not_required',
  "verifiedAt"          TIMESTAMP(3),
  "candidate"           JSONB,

  "invalidationReason"  TEXT,
  "invalidatedAt"       TIMESTAMP(3),

  "evaluatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "media_intelligence_recommendations_pkey" PRIMARY KEY ("id")
);

-- Cascade: a finding deleted because its media vanished takes its
-- recommendations with it. Nothing else deletes a finding -- reconciliation
-- resolves, never drops -- so this fires only through `forget()`.
ALTER TABLE "media_intelligence_recommendations"
  ADD CONSTRAINT "media_intelligence_recommendations_findingId_fkey"
  FOREIGN KEY ("findingId") REFERENCES "media_intelligence_findings"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The LOGICAL IDENTITY: one recommendation of a kind per finding, ever.
-- This is what makes a sweep an upsert instead of an append, and it is why a
-- rebuild cannot duplicate recommendations.
CREATE UNIQUE INDEX IF NOT EXISTS "media_intelligence_recommendations_findingId_type_key"
  ON "media_intelligence_recommendations" ("findingId", "type");

CREATE INDEX IF NOT EXISTS "media_intelligence_recommendations_status_confidence_idx"
  ON "media_intelligence_recommendations" ("status", "confidence");

CREATE INDEX IF NOT EXISTS "media_intelligence_recommendations_entityType_entityId_idx"
  ON "media_intelligence_recommendations" ("entityType", "entityId");

CREATE INDEX IF NOT EXISTS "media_intelligence_recommendations_type_status_idx"
  ON "media_intelligence_recommendations" ("type", "status");

-- Ageing a verified candidate out without scanning the table.
CREATE INDEX IF NOT EXISTS "media_intelligence_recommendations_verification_verifiedAt_idx"
  ON "media_intelligence_recommendations" ("verification", "verifiedAt");
