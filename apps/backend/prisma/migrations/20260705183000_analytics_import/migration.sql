-- AlterTable
ALTER TABLE "media_server_watch_history" ADD COLUMN "providerHistoryId" TEXT;

-- CreateTable
CREATE TABLE "media_analytics_import_sources" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "encryptedApiKey" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "syncEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastConnectionTestAt" TIMESTAMP(3),
    "lastImportAt" TIMESTAMP(3),
    "lastIncrementalSyncAt" TIMESTAMP(3),
    "importCursor" JSONB,
    "sourceVersion" TEXT,
    "status" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "media_analytics_import_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_analytics_import_jobs" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "mode" TEXT NOT NULL DEFAULT 'one_time',
    "selectedSections" JSONB,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "totalRecords" INTEGER NOT NULL DEFAULT 0,
    "processedRecords" INTEGER NOT NULL DEFAULT 0,
    "importedRecords" INTEGER NOT NULL DEFAULT 0,
    "skippedRecords" INTEGER NOT NULL DEFAULT 0,
    "failedRecords" INTEGER NOT NULL DEFAULT 0,
    "warnings" JSONB,
    "errors" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "media_analytics_import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_server_watch_history_importSourceId_providerHistoryId_key" ON "media_server_watch_history"("importSourceId", "providerHistoryId");

-- CreateIndex
CREATE INDEX "media_analytics_import_jobs_sourceId_idx" ON "media_analytics_import_jobs"("sourceId");

-- AddForeignKey
ALTER TABLE "media_analytics_import_jobs" ADD CONSTRAINT "media_analytics_import_jobs_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "media_analytics_import_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
