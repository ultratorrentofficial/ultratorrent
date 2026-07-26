-- Consecutive polls a session has been absent from the provider.
--
-- Sessions were ended on the first missed poll. Media servers drop a session from
-- /status/sessions transiently, so one viewing became several rows: spurious
-- stop/start notifications, fragmented watch history, and inflated completed-play
-- counts feeding the cleanup aggregates.
ALTER TABLE "media_server_sessions" ADD COLUMN "missedPolls" INTEGER NOT NULL DEFAULT 0;
