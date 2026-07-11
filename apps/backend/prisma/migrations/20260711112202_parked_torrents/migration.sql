-- CreateTable
CREATE TABLE "parked_torrents" (
    "hash" TEXT NOT NULL,
    "engineId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'no_seeders',
    "parkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "probingSince" TIMESTAMP(3),
    "lastProbedAt" TIMESTAMP(3),
    "probeCount" INTEGER NOT NULL DEFAULT 0,
    "lastSeeders" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parked_torrents_pkey" PRIMARY KEY ("engineId","hash")
);

-- CreateIndex
CREATE INDEX "parked_torrents_lastProbedAt_idx" ON "parked_torrents"("lastProbedAt");

-- AddForeignKey
ALTER TABLE "parked_torrents" ADD CONSTRAINT "parked_torrents_engineId_fkey" FOREIGN KEY ("engineId") REFERENCES "torrent_engines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
