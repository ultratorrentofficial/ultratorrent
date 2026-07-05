-- AlterTable
ALTER TABLE "media_items" ADD COLUMN     "seriesImdbId" TEXT;

-- CreateTable
CREATE TABLE "wanted_episodes" (
    "id" TEXT NOT NULL,
    "watchlistItemId" TEXT NOT NULL,
    "seriesTconst" TEXT NOT NULL,
    "episodeTconst" TEXT,
    "seasonNumber" INTEGER NOT NULL,
    "episodeNumber" INTEGER NOT NULL,
    "episodeTitle" TEXT,
    "airYear" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'missing',
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wanted_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wanted_episodes_watchlistItemId_idx" ON "wanted_episodes"("watchlistItemId");

-- CreateIndex
CREATE INDEX "wanted_episodes_seriesTconst_idx" ON "wanted_episodes"("seriesTconst");

-- CreateIndex
CREATE INDEX "wanted_episodes_status_idx" ON "wanted_episodes"("status");

-- CreateIndex
CREATE UNIQUE INDEX "wanted_episodes_watchlistItemId_seasonNumber_episodeNumber_key" ON "wanted_episodes"("watchlistItemId", "seasonNumber", "episodeNumber");

-- CreateIndex
CREATE INDEX "media_items_seriesImdbId_idx" ON "media_items"("seriesImdbId");
