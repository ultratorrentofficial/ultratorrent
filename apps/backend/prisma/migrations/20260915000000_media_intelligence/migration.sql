-- Media Intelligence (Phase 1): Unified Media State & Health.
--
-- Two DERIVED, REBUILDABLE tables. Neither holds an authoritative fact: source
-- domains (Media Manager, Media Acquisition, Media Intake, torrents, Media
-- Server Analytics) remain the owners, and both tables can be truncated and
-- rebuilt from them at any time.
--
-- Additive and non-destructive: two brand-new tables, no existing table is
-- modified and no data is backfilled. Applied with `prisma migrate deploy` --
-- never a shadow-db diff against a live DATABASE_URL, which resets its target.
--
-- Indexes are created inline with the tables. That is safe precisely because
-- the tables are new and empty; the prohibition on CREATE INDEX in a migration
-- applies to large populated tables, where the build blocks and a killed
-- migration leaves P3009 and a restart-looping backend.
--
-- No foreign keys to media_items/media_shows on purpose: a season owns no row
-- (it is showId:seasonNumber), and a derived projection must be rebuildable and
-- droppable without cascade-coupling it to the rows it summarises.

CREATE TABLE "media_intelligence_projections" (
  "id"             TEXT NOT NULL,
  "entityType"     TEXT NOT NULL,
  "entityId"       TEXT NOT NULL,
  "healthStatus"   TEXT NOT NULL,
  -- Nullable, never 0: a never-scored entity must not sort beside a broken one.
  "healthScore"    INTEGER,
  "title"          TEXT NOT NULL,
  "year"           INTEGER,
  "libraryId"      TEXT,
  "libraryName"    TEXT,
  "totalBytes"     BIGINT,
  "missingCount"   INTEGER,
  "lastPlayedAt"   TIMESTAMP(3),
  "findingCounts"  JSONB NOT NULL DEFAULT '{}',
  "summary"        JSONB NOT NULL DEFAULT '{}',
  "calculatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unknownDomains" JSONB NOT NULL DEFAULT '[]',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "media_intelligence_projections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "media_intelligence_projections_entityType_entityId_key"
  ON "media_intelligence_projections" ("entityType", "entityId");
CREATE INDEX "media_intelligence_projections_healthStatus_idx"
  ON "media_intelligence_projections" ("healthStatus");
CREATE INDEX "media_intelligence_projections_libraryId_idx"
  ON "media_intelligence_projections" ("libraryId");
CREATE INDEX "media_intelligence_projections_healthStatus_title_idx"
  ON "media_intelligence_projections" ("healthStatus", "title");
CREATE INDEX "media_intelligence_projections_calculatedAt_idx"
  ON "media_intelligence_projections" ("calculatedAt");

CREATE TABLE "media_intelligence_findings" (
  "id"              TEXT NOT NULL,
  "entityType"      TEXT NOT NULL,
  "entityId"        TEXT NOT NULL,
  "code"            TEXT NOT NULL,
  "domain"          TEXT NOT NULL,
  "severity"        TEXT NOT NULL,
  "evidence"        JSONB NOT NULL DEFAULT '{}',
  "source"          TEXT NOT NULL,
  "firstObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastObservedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Null while open. Findings are resolved, never deleted, so the history of
  -- "this was wrong and then it was fixed" survives.
  "resolvedAt"      TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "media_intelligence_findings_pkey" PRIMARY KEY ("id")
);

-- One row per (entity, code): a repeated evaluation of unchanged facts updates
-- this row instead of accumulating a duplicate on every sweep.
CREATE UNIQUE INDEX "media_intelligence_findings_entityType_entityId_code_key"
  ON "media_intelligence_findings" ("entityType", "entityId", "code");
CREATE INDEX "media_intelligence_findings_entityType_entityId_idx"
  ON "media_intelligence_findings" ("entityType", "entityId");
-- The Attention Center query: unresolved, worst first.
CREATE INDEX "media_intelligence_findings_resolvedAt_severity_idx"
  ON "media_intelligence_findings" ("resolvedAt", "severity");
CREATE INDEX "media_intelligence_findings_code_idx"
  ON "media_intelligence_findings" ("code");
CREATE INDEX "media_intelligence_findings_domain_idx"
  ON "media_intelligence_findings" ("domain");
