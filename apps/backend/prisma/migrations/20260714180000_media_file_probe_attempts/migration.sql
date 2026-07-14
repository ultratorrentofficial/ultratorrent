-- AlterTable: bound the retries of a TRANSIENT probe failure.
--
-- `probeError` takes a file out of the backfill's working set permanently, so it must
-- only ever record a failure the FILE caused. It was also being set when the probe merely
-- TIMED OUT — which happens on a busy NAS serving Plex, and says nothing about the file.
-- Measured: two perfectly readable files (a 2.1 GB mp4, an 826 MB mkv) were dropped this
-- way on live hosts; both probed fine by hand afterwards.
--
-- A transient failure now leaves the file in the working set to be retried, and this
-- counter is what stops that retry being unbounded.
ALTER TABLE "media_files" ADD COLUMN "probeAttempts" INTEGER NOT NULL DEFAULT 0;

-- Release the files already dropped by the old behaviour. Every one of them recorded the
-- bare "Command failed: mediainfo ..." that Node produces when it KILLS the process on
-- timeout — no stderr, because mediainfo never got to complain. A genuinely corrupt file
-- fails differently (mediainfo runs, and says why), so this cannot resurrect a real
-- failure: it only re-queues the ones we gave up on unfairly.
UPDATE "media_files"
SET "probeError" = NULL
WHERE "probeError" LIKE 'Command failed: mediainfo%';
