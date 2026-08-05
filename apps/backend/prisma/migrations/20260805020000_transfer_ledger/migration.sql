-- Persistent transfer statistics.
--
-- Totals were previously derived by summing the torrents an engine currently
-- holds, so every removal silently erased that torrent's share of the history.
-- These two tables move the number into Postgres, where it survives engine
-- restarts, container rebuilds and torrent removal.
--
-- Purely additive: no existing table or column is touched, and both tables
-- start empty. The ledger seeds its baseline on first sight of each engine.

CREATE TABLE "transfer_ledgers" (
    "engineId" TEXT NOT NULL,
    "baselineDownloaded" BIGINT NOT NULL DEFAULT 0,
    "baselineUploaded" BIGINT NOT NULL DEFAULT 0,
    "baselineSource" TEXT,
    "baselineAt" TIMESTAMP(3),
    "accruedDownloaded" BIGINT NOT NULL DEFAULT 0,
    "accruedUploaded" BIGINT NOT NULL DEFAULT 0,
    "resetsObserved" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transfer_ledgers_pkey" PRIMARY KEY ("engineId")
);

CREATE TABLE "retired_torrent_transfers" (
    "id" TEXT NOT NULL,
    "engineId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "downloaded" BIGINT NOT NULL,
    "uploaded" BIGINT NOT NULL,
    "ratio" DOUBLE PRECISION NOT NULL,
    "firstSeenAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retired_torrent_transfers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "retired_torrent_transfers_engineId_retiredAt_idx"
    ON "retired_torrent_transfers"("engineId", "retiredAt");

-- A torrent can legitimately be removed, re-added and removed again; only a
-- repeat at the very same instant is a duplicate write.
CREATE UNIQUE INDEX "retired_torrent_transfers_engineId_hash_retiredAt_key"
    ON "retired_torrent_transfers"("engineId", "hash", "retiredAt");

ALTER TABLE "transfer_ledgers" ADD CONSTRAINT "transfer_ledgers_engineId_fkey"
    FOREIGN KEY ("engineId") REFERENCES "torrent_engines"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "retired_torrent_transfers" ADD CONSTRAINT "retired_torrent_transfers_engineId_fkey"
    FOREIGN KEY ("engineId") REFERENCES "torrent_engines"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
