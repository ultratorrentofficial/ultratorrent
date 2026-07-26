-- The episode's own name, kept beside the joined display title.
--
-- A stop notification renders the series and the episode on separate lines, and
-- the only other way to recover the episode name is to re-split `title`, which
-- is ambiguous for any title containing the same separator.
ALTER TABLE "media_server_sessions" ADD COLUMN "episodeTitle" TEXT;
