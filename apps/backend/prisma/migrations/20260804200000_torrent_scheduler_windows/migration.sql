-- Recurring windows that override scheduling limits by time of day.
--
-- Local wall-clock minutes plus an IANA zone, not UTC instants: "throttle
-- overnight" means the operator's night, and their night moves twice a year.
-- Evaluation reads the clock and stores nothing, so daylight saving, a restart
-- and a clock moved backwards are all handled by asking again rather than by
-- reconciling remembered state.
--
-- Additive and empty on creation: with no windows, every schedule evaluation is
-- a no-op and the resolved policy passes through untouched.
CREATE TABLE "torrent_scheduler_windows" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "daysOfWeek" INTEGER[],
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "maxConcurrentDownloads" INTEGER,
    "maxConcurrentSeeds" INTEGER,
    "maxTotalActive" INTEGER,
    "maxDownloadRateKbps" INTEGER,
    "maxUploadRateKbps" INTEGER,
    "allowNewDownloads" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "torrent_scheduler_windows_pkey" PRIMARY KEY ("id")
);

-- Every sweep asks for the enabled ones.
CREATE INDEX "torrent_scheduler_windows_enabled_idx"
    ON "torrent_scheduler_windows"("enabled");
