-- Phase 6e: normalized analytics entities + stream detail capture.

-- Stream detail on sessions + completed playback (bandwidth/quality trends).
ALTER TABLE "media_server_sessions" ADD COLUMN "container" TEXT;
ALTER TABLE "media_server_sessions" ADD COLUMN "bitrateKbps" INTEGER;
ALTER TABLE "media_server_watch_history" ADD COLUMN "audioCodec" TEXT;
ALTER TABLE "media_server_watch_history" ADD COLUMN "container" TEXT;
ALTER TABLE "media_server_watch_history" ADD COLUMN "bitrateKbps" INTEGER;

-- Libraries synced from providers.
CREATE TABLE "media_server_libraries" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "providerLibraryId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "itemCount" INTEGER,
  "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "media_server_libraries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "media_server_libraries_connectionId_providerLibraryId_key" ON "media_server_libraries"("connectionId", "providerLibraryId");
CREATE INDEX "media_server_libraries_connectionId_idx" ON "media_server_libraries"("connectionId");

-- Distinct viewers derived from sessions + history.
CREATE TABLE "media_server_users" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT,
  "providerUserId" TEXT,
  "userName" TEXT NOT NULL,
  "plays" INTEGER NOT NULL DEFAULT 0,
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "media_server_users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "media_server_users_connectionId_userName_key" ON "media_server_users"("connectionId", "userName");
CREATE INDEX "media_server_users_userName_idx" ON "media_server_users"("userName");

-- Provider sync run tracking.
CREATE TABLE "media_provider_sync_runs" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "librariesSynced" INTEGER NOT NULL DEFAULT 0,
  "usersSynced" INTEGER NOT NULL DEFAULT 0,
  "message" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "media_provider_sync_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "media_provider_sync_runs_connectionId_idx" ON "media_provider_sync_runs"("connectionId");
CREATE INDEX "media_provider_sync_runs_startedAt_idx" ON "media_provider_sync_runs"("startedAt");
