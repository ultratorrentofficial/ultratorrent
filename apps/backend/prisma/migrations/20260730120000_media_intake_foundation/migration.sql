-- Media Intake Engine — foundation.
--
-- Additive only. Every existing RSS rule keeps its behaviour because
-- `importMode` defaults to 'legacy_direct': the column arrives already saying
-- "carry on exactly as before". New rules are set to 'managed_intake' by the
-- service layer, which is the only place that can tell an old row from a new
-- one. Nothing here moves a file, changes a save path or touches a torrent.

CREATE TABLE "storage_profiles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "stagingRoot" TEXT NOT NULL,
    "tempRoot" TEXT,
    "failedRoot" TEXT,
    "quarantineRoot" TEXT,
    "movieLibraryId" TEXT,
    "tvLibraryId" TEXT,
    "musicLibraryId" TEXT,
    "defaultStrategy" TEXT NOT NULL DEFAULT 'auto',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "storage_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "storage_profiles_name_key" ON "storage_profiles"("name");

CREATE TABLE "path_mapping_rules" (
    "id" TEXT NOT NULL,
    "space" TEXT NOT NULL,
    "fromPrefix" TEXT NOT NULL,
    "toPrefix" TEXT NOT NULL,
    "scopeId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "path_mapping_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "path_mapping_rules_space_isEnabled_idx" ON "path_mapping_rules"("space", "isEnabled");

CREATE TABLE "storage_capability_probes" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "sourceRoot" TEXT NOT NULL,
    "targetRoot" TEXT NOT NULL,
    "sameDevice" BOOLEAN NOT NULL,
    "hardlink" BOOLEAN NOT NULL,
    "reflink" BOOLEAN NOT NULL,
    "symlink" BOOLEAN NOT NULL,
    "providerRelocation" BOOLEAN NOT NULL DEFAULT false,
    "filesystem" TEXT,
    "detail" TEXT,
    "error" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "storage_capability_probes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "storage_capability_probes_profileId_sourceRoot_targetRoot_key"
    ON "storage_capability_probes"("profileId", "sourceRoot", "targetRoot");

CREATE TABLE "media_intake_jobs" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "torrentHash" TEXT,
    "engineId" TEXT,
    "sourcePath" TEXT NOT NULL,
    "importedPath" TEXT,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "resumeState" TEXT,
    "strategy" TEXT,
    "strategyReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "qualityScore" DOUBLE PRECISION,
    "mediaItemId" TEXT,
    "libraryId" TEXT,
    "startedAt" TIMESTAMP(3),
    "importedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "media_intake_jobs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "media_intake_jobs_idempotencyKey_key" ON "media_intake_jobs"("idempotencyKey");
CREATE INDEX "media_intake_jobs_state_createdAt_idx" ON "media_intake_jobs"("state", "createdAt");
CREATE INDEX "media_intake_jobs_torrentHash_idx" ON "media_intake_jobs"("torrentHash");

CREATE TABLE "media_intake_events" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT NOT NULL,
    "message" TEXT,
    "data" JSONB,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "media_intake_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "media_intake_events_jobId_createdAt_idx" ON "media_intake_events"("jobId", "createdAt");

-- RSS rules: the two additive columns. Existing rows read 'legacy_direct'.
ALTER TABLE "rss_rules" ADD COLUMN "importMode" TEXT NOT NULL DEFAULT 'legacy_direct';
ALTER TABLE "rss_rules" ADD COLUMN "storageProfileId" TEXT;

ALTER TABLE "storage_profiles" ADD CONSTRAINT "storage_profiles_movieLibraryId_fkey"
    FOREIGN KEY ("movieLibraryId") REFERENCES "media_libraries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "storage_profiles" ADD CONSTRAINT "storage_profiles_tvLibraryId_fkey"
    FOREIGN KEY ("tvLibraryId") REFERENCES "media_libraries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "storage_profiles" ADD CONSTRAINT "storage_profiles_musicLibraryId_fkey"
    FOREIGN KEY ("musicLibraryId") REFERENCES "media_libraries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "storage_capability_probes" ADD CONSTRAINT "storage_capability_probes_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "storage_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_intake_jobs" ADD CONSTRAINT "media_intake_jobs_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "storage_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_intake_events" ADD CONSTRAINT "media_intake_events_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "media_intake_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rss_rules" ADD CONSTRAINT "rss_rules_storageProfileId_fkey"
    FOREIGN KEY ("storageProfileId") REFERENCES "storage_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
