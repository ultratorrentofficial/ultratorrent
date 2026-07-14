-- AlterTable: measured technical metadata for a media file.
--
-- The existing container/videoCodec/resolution/hdr columns are PARSED FROM THE
-- FILENAME, so they are mostly empty on a renamed library: once the renamer produces
-- "Ted Lasso - S02E03 - Do the Right-est Thing.mp4" the quality tokens are gone.
-- (Measured on a real 28,994-file library: 4% had a videoCodec, 17% a resolution,
-- 0% an hdr value.) These columns hold what the container actually says.
--
-- `techSource` records provenance — 'filename' (guessed) vs 'probe' (measured) —
-- because a value you cannot trust is worse than no value, and it is also how the
-- backfill finds what is left to do. `probeError` makes an unreadable file fail once
-- rather than be retried on every tick.
ALTER TABLE "media_files"
ADD COLUMN     "width"         INTEGER,
ADD COLUMN     "height"        INTEGER,
ADD COLUMN     "bitrateKbps"   INTEGER,
ADD COLUMN     "durationSec"   INTEGER,
ADD COLUMN     "audioChannels" INTEGER,
ADD COLUMN     "frameRate"     DOUBLE PRECISION,
ADD COLUMN     "techSource"    TEXT,
ADD COLUMN     "probedAt"      TIMESTAMP(3),
ADD COLUMN     "probeError"    TEXT;

-- The backfill's working set: never probed, and not already failed.
CREATE INDEX "media_files_probedAt_probeError_idx" ON "media_files"("probedAt", "probeError");
