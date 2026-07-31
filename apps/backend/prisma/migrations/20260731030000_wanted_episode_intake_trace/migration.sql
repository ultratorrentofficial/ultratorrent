-- Let Media Intake see a missing-episode grab.
--
-- Intake identifies a completed torrent by tracing it back to the rule that
-- asked for it, and that trace runs through `rss_acquisitions`. Only the RSS
-- feed path writes those rows; missing-episode grabs go out through
-- MissingEpisodeSearchService -> SmartDownloadExecutor and write none, so every
-- such download was invisible to the pipeline.
--
-- `torrentHash` gives the trigger something to match on. `intakeRuleId` records
-- WHICH rule decided the destination, captured at grab time instead of being
-- re-derived on completion: re-deriving would let the resolver and the trigger
-- reach different answers, and a file staged by one but refused by the other is
-- stranded with nothing to import it.
--
-- Both nullable and additive. Existing rows read NULL, which means "not a
-- managed-intake grab" — exactly the pre-existing behaviour.

ALTER TABLE "wanted_episodes" ADD COLUMN "torrentHash" TEXT;
ALTER TABLE "wanted_episodes" ADD COLUMN "intakeRuleId" TEXT;

CREATE INDEX "wanted_episodes_torrentHash_idx" ON "wanted_episodes"("torrentHash");
