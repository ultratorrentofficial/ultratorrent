-- CreateTable
CREATE TABLE "wanted_movies" (
    "id" TEXT NOT NULL,
    "watchlistItemId" TEXT NOT NULL,
    "movieTconst" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'missing',
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wanted_movies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wanted_movies_watchlistItemId_key" ON "wanted_movies"("watchlistItemId");

-- CreateIndex
CREATE INDEX "wanted_movies_movieTconst_idx" ON "wanted_movies"("movieTconst");

-- CreateIndex
CREATE INDEX "wanted_movies_status_idx" ON "wanted_movies"("status");
