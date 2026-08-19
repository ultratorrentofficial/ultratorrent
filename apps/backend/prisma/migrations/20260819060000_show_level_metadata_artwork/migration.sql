-- Artwork gains a second kind of owner.
--
-- Television artwork was written onto every episode — 49 identical posters for a
-- 49-episode show on one live library — so "the show's poster" was whichever
-- episode row happened to sort first, and changing it was not an operation the
-- model could express.
ALTER TABLE "media_artwork" ALTER COLUMN "itemId" DROP NOT NULL;
ALTER TABLE "media_artwork" ADD COLUMN "showId" TEXT;

ALTER TABLE "media_artwork"
  ADD CONSTRAINT "media_artwork_owner_fkey"
  FOREIGN KEY ("showId") REFERENCES "media_shows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one owner. Two nullable columns cannot say that on their own, and a
-- row owned by both (or by neither) is unreachable from every query that reads
-- artwork by owner.
ALTER TABLE "media_artwork"
  ADD CONSTRAINT "media_artwork_one_owner"
  CHECK (("itemId" IS NOT NULL) <> ("showId" IS NOT NULL));

CREATE INDEX "media_artwork_showId_type_idx" ON "media_artwork"("showId", "type");
CREATE INDEX "media_artwork_showId_seasonNumber_idx" ON "media_artwork"("showId", "seasonNumber");

-- The TMDB series id: the artwork provider is keyed by it and a show has no item
-- to borrow one from.
ALTER TABLE "media_shows" ADD COLUMN "tmdbId" TEXT;

CREATE TABLE "media_show_metadata" (
  "id"            TEXT NOT NULL,
  "showId"        TEXT NOT NULL,
  "title"         TEXT,
  "originalTitle" TEXT,
  "sortTitle"     TEXT,
  "overview"      TEXT,
  "firstAiredAt"  TIMESTAMP(3),
  "year"          INTEGER,
  "status"        TEXT,
  "networks"      JSONB NOT NULL DEFAULT '[]',
  "genres"        JSONB NOT NULL DEFAULT '[]',
  "studios"       JSONB NOT NULL DEFAULT '[]',
  "cast"          JSONB NOT NULL DEFAULT '[]',
  "crew"          JSONB NOT NULL DEFAULT '[]',
  "rating"        DOUBLE PRECISION,
  "certification" TEXT,
  "tags"          JSONB NOT NULL DEFAULT '[]',
  "providerName"  TEXT,
  "fieldSources"  JSONB,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "media_show_metadata_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "media_show_metadata_showId_key" ON "media_show_metadata"("showId");
ALTER TABLE "media_show_metadata"
  ADD CONSTRAINT "media_show_metadata_showId_fkey"
  FOREIGN KEY ("showId") REFERENCES "media_shows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seasons were derived from episode numbers on the fly, which lists them and
-- holds nothing: there was no row for a season poster or synopsis to belong to.
CREATE TABLE "media_seasons" (
  "id"           TEXT NOT NULL,
  "showId"       TEXT NOT NULL,
  "seasonNumber" INTEGER NOT NULL,
  "title"        TEXT,
  "overview"     TEXT,
  "firstAiredAt" TIMESTAMP(3),
  "providerName" TEXT,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_seasons_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "media_seasons_showId_seasonNumber_key" ON "media_seasons"("showId", "seasonNumber");
ALTER TABLE "media_seasons"
  ADD CONSTRAINT "media_seasons_showId_fkey"
  FOREIGN KEY ("showId") REFERENCES "media_shows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
