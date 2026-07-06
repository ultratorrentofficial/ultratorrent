-- Capture stream quality on completed playback for the quality/resolution analytics.
ALTER TABLE "media_server_watch_history" ADD COLUMN "resolution" TEXT;
ALTER TABLE "media_server_watch_history" ADD COLUMN "videoCodec" TEXT;
