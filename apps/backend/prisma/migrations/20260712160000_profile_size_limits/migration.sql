-- AlterTable: release size bounds on an acquisition profile (bytes; BigInt because
-- a 1080p movie exceeds the Int32 ceiling). Null = unbounded on that side.
ALTER TABLE "media_acquisition_profiles" ADD COLUMN     "minSizeBytes" BIGINT,
ADD COLUMN     "maxSizeBytes" BIGINT;
