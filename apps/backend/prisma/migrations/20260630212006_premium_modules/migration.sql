-- CreateTable
CREATE TABLE "media_rename_jobs" (
    "id" TEXT NOT NULL,
    "torrentHash" TEXT,
    "engineId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "mode" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "destinationPath" TEXT,
    "mediaType" TEXT,
    "parsedMetadata" JSONB,
    "providerMetadata" JSONB,
    "confidenceScore" INTEGER,
    "dryRunResult" JSONB,
    "executedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "media_rename_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_rename_files" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "originalPath" TEXT NOT NULL,
    "proposedPath" TEXT,
    "finalPath" TEXT,
    "fileType" TEXT,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_rename_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_naming_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "serverPreset" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_naming_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engine_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "engine_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engine_storage_paths" (
    "id" TEXT NOT NULL,
    "engineId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "purpose" TEXT,
    "totalBytes" BIGINT,
    "usedBytes" BIGINT,
    "freeBytes" BIGINT,
    "reservedBytes" BIGINT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "engine_storage_paths_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_server_configs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "encryptedConfig" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_server_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_rename_jobs_status_idx" ON "media_rename_jobs"("status");

-- CreateIndex
CREATE INDEX "media_rename_jobs_torrentHash_idx" ON "media_rename_jobs"("torrentHash");

-- CreateIndex
CREATE INDEX "media_rename_files_jobId_idx" ON "media_rename_files"("jobId");

-- CreateIndex
CREATE INDEX "engine_storage_paths_engineId_idx" ON "engine_storage_paths"("engineId");

-- CreateIndex
CREATE INDEX "media_server_configs_provider_idx" ON "media_server_configs"("provider");

-- AddForeignKey
ALTER TABLE "media_rename_files" ADD CONSTRAINT "media_rename_files_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "media_rename_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
