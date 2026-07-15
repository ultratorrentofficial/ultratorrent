-- Subtitle Intelligence phase 2 — subtitle synchronization results.
--
-- One new table, subtitle_synchronizations, FK to subtitle_downloads (ON DELETE
-- CASCADE). Records how an installed subtitle was synced to the audio: provider
-- (ffsubsync | manual_offset | alass), method, offset/drift/confidence, and the
-- preserved original + active synced sidecar paths (the original is never
-- overwritten). No existing data is touched.
--
-- NOTE: the diff tool again emitted DROP INDEX for the IMDb trigram GIN indexes
-- (raw-SQL indexes Prisma does not model) — DELIBERATELY EXCLUDED.

-- CreateTable
CREATE TABLE "subtitle_synchronizations" (
    "id" TEXT NOT NULL,
    "downloadId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "version" TEXT,
    "offsetMs" INTEGER NOT NULL DEFAULT 0,
    "driftFactor" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "confidence" DOUBLE PRECISION,
    "matchedRegions" JSONB,
    "originalPath" TEXT NOT NULL,
    "syncedPath" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'applied',
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subtitle_synchronizations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subtitle_synchronizations_downloadId_idx" ON "subtitle_synchronizations"("downloadId");

-- AddForeignKey
ALTER TABLE "subtitle_synchronizations" ADD CONSTRAINT "subtitle_synchronizations_downloadId_fkey" FOREIGN KEY ("downloadId") REFERENCES "subtitle_downloads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

