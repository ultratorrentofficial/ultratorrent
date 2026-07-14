-- Trakt.tv account link, per user. Tokens are AES-256-GCM ciphertext.
CREATE TABLE "trakt_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT,
    "slug" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "scope" TEXT,
    "syncCollection" BOOLEAN NOT NULL DEFAULT false,
    "syncWatched" BOOLEAN NOT NULL DEFAULT false,
    "syncRatings" BOOLEAN NOT NULL DEFAULT false,
    "syncWatchlist" BOOLEAN NOT NULL DEFAULT false,
    "scrobbleEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mediaServerUserName" TEXT,
    "lastCollectionSyncAt" TIMESTAMP(3),
    "lastWatchedSyncAt" TIMESTAMP(3),
    "lastRatingsSyncAt" TIMESTAMP(3),
    "lastWatchlistSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trakt_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "trakt_accounts_userId_key" ON "trakt_accounts"("userId");

ALTER TABLE "trakt_accounts" ADD CONSTRAINT "trakt_accounts_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What a scrobble needs to identify an episode: the show (not the joined display
-- title), its season/number, and whatever ids the media server already holds.
ALTER TABLE "media_server_sessions" ADD COLUMN "showTitle" TEXT;
ALTER TABLE "media_server_sessions" ADD COLUMN "seasonNumber" INTEGER;
ALTER TABLE "media_server_sessions" ADD COLUMN "episodeNumber" INTEGER;
ALTER TABLE "media_server_sessions" ADD COLUMN "externalIds" JSONB;

-- Per-user watched state and ratings. Identity is a `key` string rather than
-- nullable id columns: a UNIQUE over nullable columns does not dedupe in
-- Postgres (NULL != NULL), so a row with no tmdb id would re-insert every sync.
CREATE TABLE "media_user_watches" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "imdbId" TEXT,
    "tmdbId" TEXT,
    "tvdbId" TEXT,
    "showTitle" TEXT,
    "title" TEXT,
    "season" INTEGER,
    "episode" INTEGER,
    "watchedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'media_server',
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_user_watches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "media_user_watches_userId_key_key" ON "media_user_watches"("userId", "key");
CREATE INDEX "media_user_watches_userId_source_idx" ON "media_user_watches"("userId", "source");
CREATE INDEX "media_user_watches_userId_syncedAt_idx" ON "media_user_watches"("userId", "syncedAt");

CREATE TABLE "media_user_ratings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "imdbId" TEXT,
    "tmdbId" TEXT,
    "tvdbId" TEXT,
    "showTitle" TEXT,
    "title" TEXT,
    "season" INTEGER,
    "episode" INTEGER,
    "rating" INTEGER NOT NULL,
    "ratedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_user_ratings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "media_user_ratings_userId_key_key" ON "media_user_ratings"("userId", "key");
CREATE INDEX "media_user_ratings_userId_source_idx" ON "media_user_ratings"("userId", "source");
