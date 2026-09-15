-- Media Intelligence (Phase 3): Attention Center workflow state.
--
-- Additive and non-destructive. Six nullable/defaulted columns on the existing
-- DERIVED findings table, one new table, three indexes. No existing column is
-- altered, no row is rewritten, and nothing is backfilled.
--
-- Pre-existing findings therefore begin as `unreviewed` via the column default
-- rather than through an UPDATE over every row, and NO synthetic history is
-- generated for them: marking thousands of long-standing findings as "opened
-- today" would be a lie told at migration time, and the history table exists
-- precisely to avoid that kind of fiction.
--
-- Applied with `prisma migrate deploy`. NEVER via a shadow-db diff against a
-- live DATABASE_URL -- `migrate diff --from-migrations` RESETS its target.
--
-- On CREATE INDEX: media_intelligence_findings holds ~4k rows on the live
-- installation, so these build in milliseconds. The standing prohibition is
-- about large populated tables, where a blocking build that gets killed leaves
-- P3009 and a restart-looping backend.

ALTER TABLE "media_intelligence_findings"
  ADD COLUMN IF NOT EXISTS "disposition"       TEXT NOT NULL DEFAULT 'unreviewed',
  ADD COLUMN IF NOT EXISTS "snoozedUntil"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "dispositionAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "dispositionBy"     TEXT,
  ADD COLUMN IF NOT EXISTS "dispositionReason" TEXT,
  ADD COLUMN IF NOT EXISTS "escalationReason"  TEXT;

CREATE TABLE IF NOT EXISTS "media_intelligence_finding_events" (
  "id"          TEXT NOT NULL,
  "findingId"   TEXT NOT NULL,
  "event"       TEXT NOT NULL,
  "actorUserId" TEXT,
  "detail"      JSONB NOT NULL DEFAULT '{}',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "media_intelligence_finding_events_pkey" PRIMARY KEY ("id")
);

-- Cascade: a finding deleted because its media vanished takes its history with
-- it. Nothing else may delete a finding -- reconciliation resolves, never drops.
ALTER TABLE "media_intelligence_finding_events"
  ADD CONSTRAINT "media_intelligence_finding_events_findingId_fkey"
  FOREIGN KEY ("findingId") REFERENCES "media_intelligence_findings"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "media_intelligence_finding_events_findingId_createdAt_idx"
  ON "media_intelligence_finding_events" ("findingId", "createdAt");

CREATE INDEX IF NOT EXISTS "media_intelligence_findings_resolvedAt_disposition_severity_idx"
  ON "media_intelligence_findings" ("resolvedAt", "disposition", "severity");

CREATE INDEX IF NOT EXISTS "media_intelligence_findings_snoozedUntil_idx"
  ON "media_intelligence_findings" ("snoozedUntil");
