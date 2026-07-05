-- CreateTable
CREATE TABLE "media_server_sessions" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "providerSessionId" TEXT NOT NULL,
    "providerUserId" TEXT,
    "userName" TEXT,
    "title" TEXT NOT NULL,
    "mediaType" TEXT,
    "libraryName" TEXT,
    "device" TEXT,
    "client" TEXT,
    "ipAddress" TEXT,
    "playbackState" TEXT,
    "progressPercent" INTEGER,
    "playbackMethod" TEXT,
    "videoCodec" TEXT,
    "audioCodec" TEXT,
    "resolution" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_server_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_server_watch_history" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT,
    "importSourceId" TEXT,
    "providerUserId" TEXT,
    "userName" TEXT,
    "title" TEXT NOT NULL,
    "mediaType" TEXT,
    "libraryName" TEXT,
    "device" TEXT,
    "client" TEXT,
    "ipAddress" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "stoppedAt" TIMESTAMP(3),
    "watchedSeconds" INTEGER,
    "percentComplete" INTEGER,
    "playbackMethod" TEXT,
    "importSource" TEXT,
    "importedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_server_watch_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_server_sessions_connectionId_idx" ON "media_server_sessions"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "media_server_sessions_connectionId_providerSessionId_key" ON "media_server_sessions"("connectionId", "providerSessionId");

-- CreateIndex
CREATE INDEX "media_server_watch_history_connectionId_idx" ON "media_server_watch_history"("connectionId");

-- CreateIndex
CREATE INDEX "media_server_watch_history_providerUserId_idx" ON "media_server_watch_history"("providerUserId");

-- CreateIndex
CREATE INDEX "media_server_watch_history_startedAt_idx" ON "media_server_watch_history"("startedAt");
