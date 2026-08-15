-- How a library learns that its files changed.
--
-- Until now the only mechanism was `scanIntervalMinutes`, opt-in and unset on
-- every library of the live install — so a file copied into a library folder was
-- invisible to UltraTorrent indefinitely while Plex, which watches the
-- filesystem, listed it within seconds.
--
-- `watchEnabled` costs one inotify watch per directory out of a per-uid budget
-- shared with the media server, so it is off by default and stays an explicit
-- choice. `scanOnStartup` closes the gap where files change while the container
-- is down.
ALTER TABLE "media_libraries" ADD COLUMN "watchEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "media_libraries" ADD COLUMN "scanOnStartup" BOOLEAN NOT NULL DEFAULT false;
