-- RSS TV Show airing-status awareness (Phase 1).
-- Additive: nullable snapshot columns on rss_rules + a status cache table.

-- AlterTable: rss_rules show-status snapshot
ALTER TABLE "rss_rules"
  ADD COLUMN "mediaType" TEXT,
  ADD COLUMN "showStatus" TEXT,
  ADD COLUMN "showStatusProvider" TEXT,
  ADD COLUMN "showStatusProviderId" TEXT,
  ADD COLUMN "showStatusCheckedAt" TIMESTAMP(3),
  ADD COLUMN "showStatusRecommendation" TEXT,
  ADD COLUMN "showFirstAirDate" TIMESTAMP(3),
  ADD COLUMN "showLastAirDate" TIMESTAMP(3),
  ADD COLUMN "showNextEpisodeAirDate" TIMESTAMP(3),
  ADD COLUMN "showStatusWarnings" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "allowInactiveShowMonitoring" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: tv_show_status (resolved-lookup cache)
CREATE TABLE "tv_show_status" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerShowId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "normalizedTitle" TEXT NOT NULL,
  "originalStatus" TEXT,
  "normalizedStatus" TEXT NOT NULL,
  "recommendation" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "firstAirDate" TIMESTAMP(3),
  "lastAirDate" TIMESTAMP(3),
  "nextEpisodeAirDate" TIMESTAMP(3),
  "lastEpisodeTitle" TEXT,
  "nextEpisodeTitle" TEXT,
  "totalSeasons" INTEGER,
  "totalEpisodes" INTEGER,
  "overview" TEXT,
  "posterUrl" TEXT,
  "warnings" JSONB NOT NULL DEFAULT '[]',
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tv_show_status_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tv_show_status_provider_providerShowId_key" ON "tv_show_status"("provider", "providerShowId");
CREATE INDEX "tv_show_status_normalizedTitle_idx" ON "tv_show_status"("normalizedTitle");
