-- What the SCHEDULER did to one torrent, kept apart from the provider's state.
--
-- Required before enforcement can work in both directions. Every engine reports
-- a paused torrent as simply `paused`, so a person's pause, the scheduler's and
-- the engine's own are indistinguishable from provider state alone. Without this
-- the scheduler could pause a torrent to free a slot and never recognise the
-- pause as its own to undo — enforcement in one direction only.
--
-- Additive, and empty on creation: no existing torrent gains a scheduler
-- attribution, so nothing already paused becomes eligible for automatic resume.
CREATE TABLE "torrent_scheduler_states" (
    "engineId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "schedulerPausedAt" TIMESTAMP(3),
    "reasonCode" TEXT,
    "lastActionAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "torrent_scheduler_states_pkey" PRIMARY KEY ("engineId","hash")
);

-- "Which torrents is the scheduler currently holding paused on this engine" —
-- asked on every sweep, and when managed mode is switched off.
CREATE INDEX "torrent_scheduler_states_engineId_schedulerPausedAt_idx"
    ON "torrent_scheduler_states"("engineId", "schedulerPausedAt");
