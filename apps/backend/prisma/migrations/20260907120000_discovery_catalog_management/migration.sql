-- Catalogue management for Media Discovery.
--
-- Two gaps this closes:
--
--   1. Editing a template changed nothing for titles it had already decided
--      about. The evaluator only considers rows with no evaluation for that
--      template, so an edit needed something to invalidate the old decisions.
--      `policyVersion` is bumped on a policy change and the template's
--      evaluations are cleared, which re-opens every title to the new policy.
--
--   2. Deleting a title from the catalogue was undone by the next sync, which
--      rebuilds from upstream every six hours. A suppression records the
--      identity that must not come back.

ALTER TABLE "discovery_templates"
  ADD COLUMN "policyVersion" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "discovery_suppressions" (
  "id"           TEXT NOT NULL,
  "dedupeKey"    TEXT NOT NULL,
  "title"        TEXT NOT NULL,
  "mediaType"    TEXT,
  "reason"       TEXT NOT NULL DEFAULT 'manual',
  "suppressedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "suppressedBy" TEXT,

  CONSTRAINT "discovery_suppressions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "discovery_suppressions_dedupeKey_key"
  ON "discovery_suppressions"("dedupeKey");
CREATE INDEX "discovery_suppressions_reason_idx"
  ON "discovery_suppressions"("reason");
