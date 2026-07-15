-- Subtitle Intelligence (core module `subtitle_intelligence`) — initial schema.
--
-- Introduces the definitive subtitle engine's storage. Nothing here touches
-- existing tables' data: eight new tables plus their FKs to media_items /
-- media_libraries (all ON DELETE CASCADE, so removing an item or library reaps
-- its subtitle rows). The old media_subtitles table (sidecar discovery under
-- media_manager) is untouched and still valid — this module OWNS acquisition and
-- writes sidecars those scans then discover.
--
--  * subtitle_provider_configs   — per-provider enablement, priority, encrypted
--                                  credentials (SecretCipher), health + daily quota.
--  * subtitle_fingerprints       — the search identity of a file (movieHash /
--                                  sha256 / runtime / external ids); one per item.
--  * subtitle_candidates         — normalized, scored provider results.
--  * subtitle_downloads          — installed subtitles (authoritative record).
--  * subtitle_validations        — pre-install structural (+ optional runtime) checks.
--  * subtitle_language_settings  — per-library required/preferred/forced policy.
--  * subtitle_history            — append-only trail (the History UI / "why this sub").
--  * subtitle_jobs               — in-process job rows for WS progress + restart reaping.
--
-- NOTE: the diff tool also emitted DROP INDEX for the IMDb trigram GIN indexes
-- (imdb_*_trgm_idx) because those are raw-SQL indexes Prisma does not model.
-- They are DELIBERATELY EXCLUDED here — dropping them would cripple IMDb search.

-- CreateTable
CREATE TABLE "subtitle_provider_configs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB NOT NULL DEFAULT '{}',
    "healthy" BOOLEAN,
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "quotaRemaining" INTEGER,
    "quotaResetAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subtitle_provider_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subtitle_fingerprints" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "fileId" TEXT,
    "movieHash" TEXT,
    "sha256" TEXT,
    "fileSize" BIGINT NOT NULL DEFAULT 0,
    "runtimeSec" INTEGER,
    "frameRate" DOUBLE PRECISION,
    "resolution" TEXT,
    "videoCodec" TEXT,
    "audioCodec" TEXT,
    "audioLanguage" TEXT,
    "container" TEXT,
    "source" TEXT,
    "releaseGroup" TEXT,
    "hdr" TEXT,
    "edition" TEXT,
    "season" INTEGER,
    "episode" INTEGER,
    "imdbId" TEXT,
    "tmdbId" TEXT,
    "tvdbId" TEXT,
    "mediaType" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subtitle_fingerprints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subtitle_candidates" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerFileId" TEXT,
    "language" TEXT NOT NULL,
    "releaseName" TEXT,
    "filename" TEXT,
    "movieHash" TEXT,
    "imdbId" TEXT,
    "tmdbId" TEXT,
    "tvdbId" TEXT,
    "season" INTEGER,
    "episode" INTEGER,
    "runtimeSec" INTEGER,
    "downloads" INTEGER,
    "uploader" TEXT,
    "rating" DOUBLE PRECISION,
    "trustedUploader" BOOLEAN NOT NULL DEFAULT false,
    "machineTranslated" BOOLEAN NOT NULL DEFAULT false,
    "hearingImpaired" BOOLEAN NOT NULL DEFAULT false,
    "forced" BOOLEAN NOT NULL DEFAULT false,
    "fileSize" BIGINT,
    "downloadUrl" TEXT,
    "matchLevel" INTEGER,
    "score" INTEGER NOT NULL DEFAULT 0,
    "scoreTier" TEXT,
    "scoreBreakdown" JSONB,
    "rawMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subtitle_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subtitle_downloads" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "forced" BOOLEAN NOT NULL DEFAULT false,
    "hearingImpaired" BOOLEAN NOT NULL DEFAULT false,
    "path" TEXT NOT NULL,
    "releaseName" TEXT,
    "score" INTEGER NOT NULL DEFAULT 0,
    "scoreTier" TEXT,
    "matchLevel" INTEGER,
    "fileSize" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'installed',
    "validationId" TEXT,
    "providerFileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subtitle_downloads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subtitle_validations" (
    "id" TEXT NOT NULL,
    "format" TEXT,
    "valid" BOOLEAN NOT NULL DEFAULT false,
    "cueCount" INTEGER NOT NULL DEFAULT 0,
    "startMs" INTEGER,
    "endMs" INTEGER,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "runtimeDeltaSec" INTEGER,
    "method" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subtitle_validations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subtitle_language_settings" (
    "id" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "requiredLanguages" JSONB NOT NULL DEFAULT '[]',
    "preferredLanguages" JSONB NOT NULL DEFAULT '[]',
    "forcedLanguages" JSONB NOT NULL DEFAULT '[]',
    "hearingImpaired" BOOLEAN NOT NULL DEFAULT false,
    "machineTranslation" BOOLEAN NOT NULL DEFAULT false,
    "preferredProviders" JSONB NOT NULL DEFAULT '[]',
    "synchronizationRequired" BOOLEAN NOT NULL DEFAULT false,
    "minimumScore" INTEGER NOT NULL DEFAULT 50,
    "automaticReplacement" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subtitle_language_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subtitle_history" (
    "id" TEXT NOT NULL,
    "itemId" TEXT,
    "action" TEXT NOT NULL,
    "provider" TEXT,
    "language" TEXT,
    "score" INTEGER,
    "message" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subtitle_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subtitle_jobs" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "libraryId" TEXT,
    "itemId" TEXT,
    "provider" TEXT,
    "language" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subtitle_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subtitle_provider_configs_provider_key" ON "subtitle_provider_configs"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "subtitle_fingerprints_itemId_key" ON "subtitle_fingerprints"("itemId");

-- CreateIndex
CREATE INDEX "subtitle_fingerprints_movieHash_idx" ON "subtitle_fingerprints"("movieHash");

-- CreateIndex
CREATE INDEX "subtitle_fingerprints_imdbId_idx" ON "subtitle_fingerprints"("imdbId");

-- CreateIndex
CREATE INDEX "subtitle_fingerprints_tmdbId_idx" ON "subtitle_fingerprints"("tmdbId");

-- CreateIndex
CREATE INDEX "subtitle_candidates_itemId_language_idx" ON "subtitle_candidates"("itemId", "language");

-- CreateIndex
CREATE INDEX "subtitle_candidates_provider_idx" ON "subtitle_candidates"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "subtitle_downloads_validationId_key" ON "subtitle_downloads"("validationId");

-- CreateIndex
CREATE INDEX "subtitle_downloads_itemId_idx" ON "subtitle_downloads"("itemId");

-- CreateIndex
CREATE INDEX "subtitle_downloads_status_idx" ON "subtitle_downloads"("status");

-- CreateIndex
CREATE INDEX "subtitle_downloads_provider_idx" ON "subtitle_downloads"("provider");

-- CreateIndex
CREATE INDEX "subtitle_downloads_language_idx" ON "subtitle_downloads"("language");

-- CreateIndex
CREATE UNIQUE INDEX "subtitle_language_settings_libraryId_key" ON "subtitle_language_settings"("libraryId");

-- CreateIndex
CREATE INDEX "subtitle_history_itemId_idx" ON "subtitle_history"("itemId");

-- CreateIndex
CREATE INDEX "subtitle_history_action_idx" ON "subtitle_history"("action");

-- CreateIndex
CREATE INDEX "subtitle_history_createdAt_idx" ON "subtitle_history"("createdAt");

-- CreateIndex
CREATE INDEX "subtitle_jobs_status_idx" ON "subtitle_jobs"("status");

-- CreateIndex
CREATE INDEX "subtitle_jobs_type_idx" ON "subtitle_jobs"("type");

-- CreateIndex
CREATE INDEX "subtitle_jobs_libraryId_idx" ON "subtitle_jobs"("libraryId");

-- AddForeignKey
ALTER TABLE "subtitle_fingerprints" ADD CONSTRAINT "subtitle_fingerprints_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subtitle_candidates" ADD CONSTRAINT "subtitle_candidates_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subtitle_downloads" ADD CONSTRAINT "subtitle_downloads_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subtitle_downloads" ADD CONSTRAINT "subtitle_downloads_validationId_fkey" FOREIGN KEY ("validationId") REFERENCES "subtitle_validations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subtitle_language_settings" ADD CONSTRAINT "subtitle_language_settings_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "media_libraries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subtitle_history" ADD CONSTRAINT "subtitle_history_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

