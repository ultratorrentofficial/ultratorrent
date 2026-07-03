-- CreateTable
CREATE TABLE "media_libraries" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'tv',
    "path" TEXT NOT NULL,
    "preset" TEXT NOT NULL DEFAULT 'plex',
    "template" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'hardlink',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_libraries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_rename_operations" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "destination" TEXT,
    "action" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "torrentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_rename_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_rename_operations_torrentHash_idx" ON "media_rename_operations"("torrentHash");

-- CreateIndex
CREATE INDEX "media_rename_operations_createdAt_idx" ON "media_rename_operations"("createdAt");
