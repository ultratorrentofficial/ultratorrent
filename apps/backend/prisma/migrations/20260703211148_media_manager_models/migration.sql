-- AlterTable
ALTER TABLE "media_libraries" ADD COLUMN     "artworkEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastScanAt" TIMESTAMP(3),
ADD COLUMN     "nfoEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scanIntervalMinutes" INTEGER;

-- CreateTable
CREATE TABLE "media_items" (
    "id" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL DEFAULT 'other_video',
    "title" TEXT NOT NULL,
    "sortTitle" TEXT,
    "year" INTEGER,
    "season" INTEGER,
    "episode" INTEGER,
    "matchStatus" TEXT NOT NULL DEFAULT 'unmatched',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "path" TEXT NOT NULL,
    "duplicateGroupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_files" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "size" BIGINT NOT NULL DEFAULT 0,
    "container" TEXT,
    "videoCodec" TEXT,
    "audioCodec" TEXT,
    "resolution" TEXT,
    "hdr" TEXT,
    "language" TEXT,
    "releaseGroup" TEXT,
    "quality" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_metadata" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "title" TEXT,
    "originalTitle" TEXT,
    "sortTitle" TEXT,
    "overview" TEXT,
    "releaseDate" TIMESTAMP(3),
    "year" INTEGER,
    "runtime" INTEGER,
    "genres" JSONB NOT NULL DEFAULT '[]',
    "studios" JSONB NOT NULL DEFAULT '[]',
    "cast" JSONB NOT NULL DEFAULT '[]',
    "crew" JSONB NOT NULL DEFAULT '[]',
    "directors" JSONB NOT NULL DEFAULT '[]',
    "writers" JSONB NOT NULL DEFAULT '[]',
    "rating" DOUBLE PRECISION,
    "certification" TEXT,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "providerName" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_metadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_artwork" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "url" TEXT,
    "localPath" TEXT,
    "source" TEXT,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "width" INTEGER,
    "height" INTEGER,
    "seasonNumber" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_artwork_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_subtitles" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "forced" BOOLEAN NOT NULL DEFAULT false,
    "sdh" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_subtitles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_external_ids" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT,

    CONSTRAINT "media_external_ids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_collections" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "overview" TEXT,
    "artworkPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_collection_items" (
    "collectionId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,

    CONSTRAINT "media_collection_items_pkey" PRIMARY KEY ("collectionId","itemId")
);

-- CreateTable
CREATE TABLE "media_rename_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_rename_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_processing_jobs" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "libraryId" TEXT,
    "itemId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_processing_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_duplicate_groups" (
    "id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_duplicate_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_server_integrations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRefreshAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_server_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_nfo_files" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_nfo_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_items_mediaType_idx" ON "media_items"("mediaType");

-- CreateIndex
CREATE INDEX "media_items_title_idx" ON "media_items"("title");

-- CreateIndex
CREATE INDEX "media_items_year_idx" ON "media_items"("year");

-- CreateIndex
CREATE INDEX "media_items_libraryId_idx" ON "media_items"("libraryId");

-- CreateIndex
CREATE INDEX "media_items_matchStatus_idx" ON "media_items"("matchStatus");

-- CreateIndex
CREATE INDEX "media_items_duplicateGroupId_idx" ON "media_items"("duplicateGroupId");

-- CreateIndex
CREATE INDEX "media_files_itemId_idx" ON "media_files"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "media_metadata_itemId_key" ON "media_metadata"("itemId");

-- CreateIndex
CREATE INDEX "media_artwork_itemId_type_idx" ON "media_artwork"("itemId", "type");

-- CreateIndex
CREATE INDEX "media_subtitles_itemId_idx" ON "media_subtitles"("itemId");

-- CreateIndex
CREATE INDEX "media_external_ids_provider_externalId_idx" ON "media_external_ids"("provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "media_external_ids_itemId_provider_key" ON "media_external_ids"("itemId", "provider");

-- CreateIndex
CREATE INDEX "media_processing_jobs_status_idx" ON "media_processing_jobs"("status");

-- CreateIndex
CREATE INDEX "media_processing_jobs_type_idx" ON "media_processing_jobs"("type");

-- CreateIndex
CREATE INDEX "media_processing_jobs_libraryId_idx" ON "media_processing_jobs"("libraryId");

-- CreateIndex
CREATE INDEX "media_nfo_files_itemId_idx" ON "media_nfo_files"("itemId");

-- AddForeignKey
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "media_libraries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_duplicateGroupId_fkey" FOREIGN KEY ("duplicateGroupId") REFERENCES "media_duplicate_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_metadata" ADD CONSTRAINT "media_metadata_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_artwork" ADD CONSTRAINT "media_artwork_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_subtitles" ADD CONSTRAINT "media_subtitles_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_external_ids" ADD CONSTRAINT "media_external_ids_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_collection_items" ADD CONSTRAINT "media_collection_items_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "media_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_collection_items" ADD CONSTRAINT "media_collection_items_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_nfo_files" ADD CONSTRAINT "media_nfo_files_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
