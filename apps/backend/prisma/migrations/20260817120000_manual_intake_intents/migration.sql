-- How a MANUALLY added torrent reaches Media Intake.
--
-- Until now intake could only be started by rule provenance: an RSS grab traced
-- through `rss_acquisitions`, or a missing-episode grab carrying `intakeRuleId`.
-- A hand-added torrent traces to neither and was therefore never intercepted, so
-- the operator's only route was to save it somewhere sensible and then call the
-- manual enqueue endpoint by hand. Forgetting the second half is what leaves a
-- download inside a library folder, where auto-organize moves the video, strands
-- its sidecars and drops the torrent it can no longer seed.
--
-- One row = one explicit decision made in the Add Torrent dialog, recorded
-- against the hash the engine returned. `consumedAt` closes it out; the row is
-- kept so the timeline can still answer "why was this staged".
CREATE TABLE "intake_intents" (
    "hash" TEXT NOT NULL,
    "engineId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "intake_intents_pkey" PRIMARY KEY ("engineId","hash")
);

-- The sweeper's query: every intent still waiting for its download to finish.
CREATE INDEX "intake_intents_consumedAt_idx" ON "intake_intents"("consumedAt");

ALTER TABLE "intake_intents" ADD CONSTRAINT "intake_intents_engineId_fkey"
    FOREIGN KEY ("engineId") REFERENCES "torrent_engines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "intake_intents" ADD CONSTRAINT "intake_intents_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "storage_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
