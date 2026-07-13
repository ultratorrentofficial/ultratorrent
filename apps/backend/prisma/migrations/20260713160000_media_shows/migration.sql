-- A TV show that EXISTS in a library, as one row per show folder on disk.
--
-- The show entity was previously re-derived in memory three separate times, by
-- climbing showFolderRoot(path) from every episode row. The derivation used to
-- choose a download's target folder had to RECONSTRUCT a folder name from the
-- show's title whenever it found no match, which is how "TV Shows/Ghosts 2021
-- (2021)" and "TV Shows/Happys Place" came to exist beside the real folders.
--
-- This table records the folder the scanner actually SAW. No backfill: the table
-- is valid empty, and the next library scan (manual, or the 5-minute scheduler
-- tick) populates it — the same convention the rest of the migrations follow.

-- CreateTable
CREATE TABLE "media_shows" (
    "id" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL DEFAULT 'tv',
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "path" TEXT NOT NULL,
    "imdbId" TEXT,
    "canonicalKey" TEXT NOT NULL,
    "episodeCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_shows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_shows_libraryId_path_key" ON "media_shows"("libraryId", "path");

-- CreateIndex
CREATE INDEX "media_shows_imdbId_idx" ON "media_shows"("imdbId");

-- CreateIndex
CREATE INDEX "media_shows_canonicalKey_idx" ON "media_shows"("canonicalKey");

-- CreateIndex
CREATE INDEX "media_shows_libraryId_idx" ON "media_shows"("libraryId");

-- AddForeignKey
ALTER TABLE "media_shows" ADD CONSTRAINT "media_shows_libraryId_fkey"
    FOREIGN KEY ("libraryId") REFERENCES "media_libraries"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
-- Nullable, so every existing watchlist row stays valid without a backfill. It is
-- bound when a show is picked from the library; a show not in the library yet
-- (libraryShowId IS NULL) still resolves its folder by name, as before.
ALTER TABLE "media_acquisition_watchlist_items" ADD COLUMN "libraryShowId" TEXT;

-- CreateIndex
CREATE INDEX "media_acquisition_watchlist_items_libraryShowId_idx"
    ON "media_acquisition_watchlist_items"("libraryShowId");

-- AddForeignKey
-- SET NULL, not CASCADE: if a show folder disappears from the library we must not
-- silently delete the user's monitoring — the item falls back to name resolution.
ALTER TABLE "media_acquisition_watchlist_items" ADD CONSTRAINT "media_acquisition_watchlist_items_libraryShowId_fkey"
    FOREIGN KEY ("libraryShowId") REFERENCES "media_shows"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
