-- An operator's instruction about one torrent, overriding what policy decided.
--
-- Deliberately separate from `torrent_scheduler_states`, which records what the
-- scheduler DID. This records what a person WANTS. Clearing the scheduler's
-- memory of a pause must never discard someone's instruction to protect a
-- torrent, and one table for both would make that mistake easy.
--
-- An expired override is ignored at READ time rather than deleted by a job, so
-- expiry is a property of the clock and no cleanup task is load-bearing: if it
-- never runs, nothing wrongly remains in force.
CREATE TABLE "torrent_scheduler_overrides" (
    "id" TEXT NOT NULL,
    "engineId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "clearedAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "torrent_scheduler_overrides_pkey" PRIMARY KEY ("id")
);

-- One live instruction of each kind per torrent; re-applying updates rather than
-- accumulating duplicates that would have to be reconciled.
CREATE UNIQUE INDEX "torrent_scheduler_overrides_engineId_hash_kind_key"
    ON "torrent_scheduler_overrides"("engineId", "hash", "kind");

CREATE INDEX "torrent_scheduler_overrides_engineId_clearedAt_idx"
    ON "torrent_scheduler_overrides"("engineId", "clearedAt");
